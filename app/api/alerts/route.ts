import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { detections, mitigations } from "@/db/schema";
import { resolveVisibleDevices } from "@/lib/device-filter";

export const dynamic = "force-dynamic";

// Umbral de "alta confianza" para marcar la fila como bloqueada (ver app/api/stats/route.ts).
const BLOCK_THRESHOLD = 0.7;
const DEFAULT_LIMIT = 8;

export async function GET(request: Request) {
  const scope = await resolveVisibleDevices(request);
  if (!scope.ok) return NextResponse.json({ error: "No autorizado." }, { status: scope.status });
  if (scope.deviceIds.length === 0) return NextResponse.json([]);

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 50);

  const rows = await db
    .select({ detection: detections, mitigatedAt: mitigations.createdAt })
    .from(detections)
    .leftJoin(mitigations, eq(mitigations.detectionId, detections.id))
    .where(inArray(detections.deviceId, scope.deviceIds))
    .orderBy(desc(detections.timestamp))
    .limit(limit);

  // Shape que espera dashboard.js: { id, time, ip, type, prob, blocked, mitigated }.
  const alerts = rows.map(({ detection: row, mitigatedAt }) => ({
    id: row.id,
    time: row.timestamp.toISOString(),
    ip: row.srcIpHash,
    type: row.attackType,
    prob: row.attackProb,
    blocked: row.attackProb >= BLOCK_THRESHOLD,
    mitigated: !!mitigatedAt,
  }));

  return NextResponse.json(alerts);
}
