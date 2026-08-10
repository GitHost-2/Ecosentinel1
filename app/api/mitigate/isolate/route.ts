import { NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { detections, devices, isolationOrders } from "@/db/schema";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// Misma "alta confianza" que /api/mitigate (route.ts hermana): no se pide un
// corte real de red sobre una detección que podría ser un falso positivo.
const BLOCK_THRESHOLD = 0.7;
const MAX_DETECTION_ID = 2_147_483_647;

/**
 * Pide el AISLAMIENTO REAL de la IP de una detección: corte por ARP spoofing,
 * ejecutado en la Raspberry Pi (ver rpi/arp_isolate.py). Distinta de
 * POST /api/mitigate (que solo registra la confirmación humana y da una guía
 * manual): esta ruta encola una orden de trabajo para el dispositivo.
 *
 * Por qué esto NO ejecuta nada aquí: la IP real nunca llega a este backend
 * (solo su hash). El corte tiene que correr en la RPi, que es la única que
 * puede resolver el hash a la IP real -- y solo durante una ventana corta,
 * contra su propio mapa local efímero. Esta ruta solo dice "quiero que la
 * IP detrás de este hash quede aislada"; la RPi decide si puede cumplirlo.
 *
 * La confirmación con la IP real y el dispositivo identificado ocurre en el
 * panel LOCAL de la RPi (http://<rpi>:8843/), no aquí -- es el único lugar
 * donde esa IP existe en texto plano.
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
  if (detection.attackProb < BLOCK_THRESHOLD) {
    return NextResponse.json(
      { error: "Esta detección no alcanza la confianza mínima (70%) para pedir aislamiento." },
      { status: 400 },
    );
  }

  // Upsert por (deviceId, srcIpHash): si ya había una orden para este mismo
  // atacante (aislada, liberada o fallida), esto la reabre como pendiente en
  // vez de duplicarla -- el índice único lo garantiza.
  const [order] = await db
    .insert(isolationOrders)
    .values({
      deviceId: detection.deviceId,
      srcIpHash: detection.srcIpHash,
      detectionId: detection.id,
      desired: "isolated",
      applied: "pending",
      requestedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [isolationOrders.deviceId, isolationOrders.srcIpHash],
      set: {
        detectionId: detection.id,
        desired: "isolated",
        applied: "pending",
        note: null,
        requestedByUserId: userId,
        requestedAt: sql`now()`,
        resolvedAt: null,
      },
    })
    .returning({ id: isolationOrders.id });

  return NextResponse.json({
    ok: true,
    orderId: order.id,
    status: "pending",
    message:
      "Solicitud enviada a tu Raspberry Pi. Confírmala en su panel local (http://ecosentinel.local:8843/) -- ahí verás la IP real y el dispositivo antes de aislarlo.",
  });
}
