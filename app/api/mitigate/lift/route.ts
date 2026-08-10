import { NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { detections, devices, isolationOrders } from "@/db/schema";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

const MAX_DETECTION_ID = 2_147_483_647;

/**
 * Pide QUITAR un aislamiento real activo (ver app/api/mitigate/isolate).
 * Mismo mecanismo, al revés: solo cambia `desired` a 'released' y deja
 * `applied` en pending hasta que la RPi confirme que restauró el ARP real
 * del atacante y del gateway.
 */
export async function POST(request: Request) {
  const userId = getSessionUserId(request);
  if (!userId) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const detectionId = Number(body?.detectionId);
  if (!Number.isInteger(detectionId) || detectionId <= 0 || detectionId > MAX_DETECTION_ID) {
    return NextResponse.json({ error: "detectionId inválido." }, { status: 400 });
  }

  const [row] = await db
    .select({ detection: detections })
    .from(detections)
    .innerJoin(devices, eq(devices.id, detections.deviceId))
    .where(and(eq(detections.id, detectionId), eq(devices.ownerUserId, userId)))
    .limit(1);
  const detection = row?.detection;
  if (!detection) {
    return NextResponse.json({ error: "Detección no encontrada." }, { status: 404 });
  }

  const [existing] = await db
    .select({ id: isolationOrders.id, desired: isolationOrders.desired, applied: isolationOrders.applied })
    .from(isolationOrders)
    .where(and(eq(isolationOrders.deviceId, detection.deviceId), eq(isolationOrders.srcIpHash, detection.srcIpHash)))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "No hay ningún aislamiento activo para esta IP." }, { status: 404 });
  }
  if (existing.desired === "released" && existing.applied !== "isolated") {
    return NextResponse.json({ error: "Esta IP ya no está aislada." }, { status: 400 });
  }

  await db
    .update(isolationOrders)
    .set({ desired: "released", applied: "pending", note: null, requestedByUserId: userId, requestedAt: sql`now()`, resolvedAt: null })
    .where(eq(isolationOrders.id, existing.id));

  return NextResponse.json({
    ok: true,
    status: "pending",
    message: "Solicitud de liberación enviada a tu Raspberry Pi.",
  });
}
