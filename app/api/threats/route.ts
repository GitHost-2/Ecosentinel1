import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { detections } from "@/db/schema";
import { THREAT_META, type AttackTypeLabel } from "@/lib/threat-meta";
import { parseDeviceIdParam } from "@/lib/device-filter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const deviceId = parseDeviceIdParam(request);
  const deviceCond = deviceId ? sql`and ${detections.deviceId} = ${deviceId}` : sql``;

  const rows = await db
    .select({
      attackType: detections.attackType,
      count: sql<number>`count(*)::int`,
    })
    .from(detections)
    .where(sql`${detections.timestamp} >= now() - interval '30 days' ${deviceCond}`)
    .groupBy(detections.attackType);

  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;

  // Mismo shape que consumía la dona y las tarjetas de "Amenazas activas":
  // [{ key, label, pct, color, tips, count }]
  const threats = (Object.keys(THREAT_META) as AttackTypeLabel[]).map((label) => {
    const meta = THREAT_META[label];
    const row = rows.find((r) => r.attackType === label);
    const count = row?.count ?? 0;
    return {
      key: meta.key,
      label,
      pct: Math.round((count / total) * 100),
      color: meta.color,
      tips: meta.tips,
      count,
    };
  });

  return NextResponse.json(threats);
}
