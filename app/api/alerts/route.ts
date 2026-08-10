import { NextResponse } from "next/server";
import { desc, eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { detections, mitigations, isolationOrders } from "@/db/schema";
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
    .select({ detection: detections, mitigatedAt: mitigations.createdAt, isolation: isolationOrders.applied })
    .from(detections)
    .leftJoin(mitigations, eq(mitigations.detectionId, detections.id))
    // Por (deviceId, srcIpHash), no por detectionId: la orden de aislamiento
    // aplica al ATACANTE, así que otras detecciones del mismo hash también
    // deben mostrarse como aisladas, no solo la que la disparó.
    .leftJoin(
      isolationOrders,
      and(eq(isolationOrders.deviceId, detections.deviceId), eq(isolationOrders.srcIpHash, detections.srcIpHash)),
    )
    .where(inArray(detections.deviceId, scope.deviceIds))
    .orderBy(desc(detections.timestamp))
    .limit(limit);

  // Shape que espera dashboard.js: { id, time, ip, type, prob, blocked, mitigated, isolation }.
  // `isolation`: null (nunca se pidió) | 'pending' | 'isolated' | 'released' | 'failed'.
  const alerts = rows.map(({ detection: row, mitigatedAt, isolation }) => ({
    id: row.id,
    time: row.timestamp.toISOString(),
    ip: row.srcIpHash,
    type: row.attackType,
    prob: row.attackProb,
    blocked: row.attackProb >= BLOCK_THRESHOLD,
    mitigated: !!mitigatedAt,
    isolation: isolation ?? null,
  }));

  return NextResponse.json(alerts);
}
