import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { detections, deviceHeartbeats } from "@/db/schema";
import { parseDeviceIdParam } from "@/lib/device-filter";

export const dynamic = "force-dynamic";

// Umbral calibrado del modelo (mismo valor que se muestra en el dashboard).
const BLOCK_THRESHOLD = 0.1;

export async function GET(request: Request) {
  const deviceId = parseDeviceIdParam(request);
  const deviceCond = deviceId ? sql`${detections.deviceId} = ${deviceId}` : sql`true`;
  const hbDeviceCond = deviceId ? sql`${deviceHeartbeats.deviceId} = ${deviceId}` : sql`true`;

  const [{ detected }] = await db
    .select({ detected: sql<number>`count(*)::int` })
    .from(detections)
    .where(deviceCond);

  const [{ blocked }] = await db
    .select({ blocked: sql<number>`count(*)::int` })
    .from(detections)
    .where(sql`${detections.attackProb} >= ${BLOCK_THRESHOLD} and ${deviceCond}`);

  // Suma de los deltas de packets_processed reportados por heartbeat; 0 si aún no hay heartbeats.
  const [{ packets }] = await db
    .select({ packets: sql<number>`coalesce(sum(${deviceHeartbeats.packetsProcessed}), 0)::bigint` })
    .from(deviceHeartbeats)
    .where(hbDeviceCond);

  return NextResponse.json({ packets: Number(packets), detected, blocked });
}
