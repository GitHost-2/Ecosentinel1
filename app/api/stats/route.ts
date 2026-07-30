import { NextResponse } from "next/server";
import { sql, inArray, and } from "drizzle-orm";
import { db } from "@/db";
import { detections, deviceHeartbeats } from "@/db/schema";
import { resolveVisibleDevices } from "@/lib/device-filter";

export const dynamic = "force-dynamic";

// Umbral de "alta confianza" para contar como bloqueado (el modelo ya decide
// qué es un ataque; este es más alto para que "bloqueado" no sea siempre
// igual a "detectado").
const BLOCK_THRESHOLD = 0.7;

export async function GET(request: Request) {
  const scope = await resolveVisibleDevices(request);
  if (!scope.ok) return NextResponse.json({ error: "No autorizado." }, { status: scope.status });
  if (scope.deviceIds.length === 0) {
    return NextResponse.json({ packets: 0, detected: 0, blocked: 0 });
  }

  const detScope = inArray(detections.deviceId, scope.deviceIds);

  const [{ detected }] = await db
    .select({ detected: sql<number>`count(*)::int` })
    .from(detections)
    .where(detScope);

  const [{ blocked }] = await db
    .select({ blocked: sql<number>`count(*)::int` })
    .from(detections)
    .where(and(detScope, sql`${detections.attackProb} >= ${BLOCK_THRESHOLD}`));

  // Suma de los deltas de packets_processed reportados por heartbeat; 0 si aún no hay heartbeats.
  const [{ packets }] = await db
    .select({ packets: sql<number>`coalesce(sum(${deviceHeartbeats.packetsProcessed}), 0)::bigint` })
    .from(deviceHeartbeats)
    .where(inArray(deviceHeartbeats.deviceId, scope.deviceIds));

  return NextResponse.json({ packets: Number(packets), detected, blocked });
}
