import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { isolationOrders } from "@/db/schema";
import { authenticateDevice } from "@/lib/device-auth";
import { LIMITS, checkRateLimitSafe, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * La Raspberry Pi pregunta aquí qué órdenes de aislamiento tiene pendientes.
 *
 * Auth: Authorization: Bearer <api_key del dispositivo> (igual que /api/ingest/*).
 *
 * Solo viaja el HASH de la IP -- nunca la IP real. Es tarea de la RPi
 * resolver ese hash contra su propio mapa local efímero (ver
 * rpi/arp_isolate.py); si ya no está ahí, no puede cumplir la orden.
 */
export async function GET(request: Request) {
  const ip = clientIp(request);
  const byIp = await checkRateLimitSafe({ key: `mitigate-pending:ip:${ip}`, ...LIMITS.ingestPerIp });
  if (!byIp.allowed) {
    return tooManyRequests("Demasiadas peticiones.", byIp.retryAfterSeconds);
  }

  let deviceId: number | null;
  try {
    deviceId = await authenticateDevice(request);
  } catch (err) {
    console.error("[mitigate/pending] fallo al autenticar dispositivo:", err);
    return NextResponse.json({ error: "Fallo interno al autenticar." }, { status: 500 });
  }
  if (!deviceId) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const rows = await db
    .select({
      orderId: isolationOrders.id,
      srcIpHash: isolationOrders.srcIpHash,
      desired: isolationOrders.desired,
    })
    .from(isolationOrders)
    .where(and(eq(isolationOrders.deviceId, deviceId), eq(isolationOrders.applied, "pending")));

  return NextResponse.json(rows.map((o) => ({ orderId: o.orderId, srcIpHash: o.srcIpHash, desired: o.desired })));
}
