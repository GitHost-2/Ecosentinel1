import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

const BLOCK_THRESHOLD = 0.1;
const HOURS = 24;

export async function GET() {
  const rows = await db.execute<{ hour_bucket: Date; detected: number; blocked: number }>(sql`
    select
      date_trunc('hour', "timestamp") as hour_bucket,
      count(*)::int as detected,
      count(*) filter (where attack_prob >= ${BLOCK_THRESHOLD})::int as blocked
    from detections
    where "timestamp" >= now() - interval '${sql.raw(String(HOURS))} hours'
    group by hour_bucket
    order by hour_bucket
  `);

  const byHour = new Map<number, { detected: number; blocked: number }>();
  for (const row of rows as unknown as { hour_bucket: string; detected: number; blocked: number }[]) {
    byHour.set(new Date(row.hour_bucket).getTime(), { detected: row.detected, blocked: row.blocked });
  }

  // Mismo shape que consumía drawChart(): dos arrays paralelos de 24
  // enteros, del más antiguo al más reciente.
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
