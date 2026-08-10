import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { isolationOrders } from "@/db/schema";
import { authenticateDevice } from "@/lib/device-auth";
import { LIMITS, checkRateLimitSafe, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const VALID_APPLIED = new Set(["isolated", "released", "failed"]);
const MAX_NOTE_LENGTH = 300;

/**
 * La Raspberry Pi reporta aquí el resultado de una orden (ver
 * app/api/mitigate/pending). Nunca lleva la IP -- solo el resultado.
 *
 * Body: { orderId, applied: 'isolated'|'released'|'failed', note? }
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const byIp = await checkRateLimitSafe({ key: `mitigate-ack:ip:${ip}`, ...LIMITS.ingestPerIp });
  if (!byIp.allowed) {
    return tooManyRequests("Demasiadas peticiones.", byIp.retryAfterSeconds);
  }

  let deviceId: number | null;
  try {
    deviceId = await authenticateDevice(request);
  } catch (err) {
    console.error("[mitigate/ack] fallo al autenticar dispositivo:", err);
    return NextResponse.json({ error: "Fallo interno al autenticar." }, { status: 500 });
  }
  if (!deviceId) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const orderId = Number(body?.orderId);
  const applied = typeof body?.applied === "string" ? body.applied : "";
  const note = typeof body?.note === "string" ? body.note.slice(0, MAX_NOTE_LENGTH) : null;

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "orderId inválido." }, { status: 400 });
  }
  if (!VALID_APPLIED.has(applied)) {
    return NextResponse.json({ error: "applied debe ser 'isolated', 'released' o 'failed'." }, { status: 400 });
  }

  // Scoping por dispositivo EN el UPDATE: un device_id autenticado no puede
  // confirmar la orden de otro (aunque adivine el id, el WHERE no matchea).
  const [updated] = await db
    .update(isolationOrders)
    .set({ applied, note, resolvedAt: sql`now()` })
    .where(and(eq(isolationOrders.id, orderId), eq(isolationOrders.deviceId, deviceId)))
    .returning({ id: isolationOrders.id });

  if (!updated) {
    return NextResponse.json({ error: "Orden no encontrada para este dispositivo." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
