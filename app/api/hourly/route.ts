import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { resolveVisibleDevices } from "@/lib/device-filter";

export const dynamic = "force-dynamic";

// Umbral de "alta confianza" para contar como bloqueado (ver app/api/stats/route.ts).
const BLOCK_THRESHOLD = 0.7;
const HOURS = 24;

export async function GET(request: Request) {
  const scope = await resolveVisibleDevices(request);
  if (!scope.ok) return NextResponse.json({ error: "No autorizado." }, { status: scope.status });

  const byHour = new Map<number, { detected: number; blocked: number }>();

  if (scope.deviceIds.length > 0) {
    const result = await db.execute<{ hour_bucket: string; detected: number; blocked: number }>(sql`
      select
        date_trunc('hour', "timestamp") as hour_bucket,
        count(*)::int as detected,
        count(*) filter (where attack_prob >= ${BLOCK_THRESHOLD})::int as blocked
      from detections
      where "timestamp" >= now() - interval '${sql.raw(String(HOURS))} hours'
        and device_id in (${sql.join(scope.deviceIds.map((id) => sql`${id}`), sql`, `)})
      group by hour_bucket
      order by hour_bucket
    `);

    // neon-http devuelve { rows, fields, ... }, no un array directo.
    for (const row of result.rows) {
      byHour.set(new Date(row.hour_bucket).getTime(), { detected: row.detected, blocked: row.blocked });
    }
  }

  // Dos arrays paralelos de 24 enteros, del más antiguo al más reciente (shape que espera drawChart()).
  const det: number[] = [];
  const blk: number[] = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);

  for (let i = HOURS - 1; i >= 0; i--) {
    const bucketTime = new Date(now.getTime() - i * 60 * 60 * 1000).getTime();
    const bucket = byHour.get(bucketTime);
    det.push(bucket?.detected ?? 0);
    blk.push(bucket?.blocked ?? 0);
  }

  return NextResponse.json({ detected: det, blocked: blk });
}
