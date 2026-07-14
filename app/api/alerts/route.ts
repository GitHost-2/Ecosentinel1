import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { detections } from "@/db/schema";

export const dynamic = "force-dynamic";

const BLOCK_THRESHOLD = 0.1;
const DEFAULT_LIMIT = 8;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 50);

  const rows = await db
    .select()
    .from(detections)
    .orderBy(desc(detections.timestamp))
    .limit(limit);

  // Shape compatible con el objeto "alerta" que ya consumía dashboard.js
  // ({ time, ip, type, prob, blocked }), + `id` para que el polling en
  // vivo pueda deduplicar contra lo que ya está en pantalla.
  const alerts = rows.map((row) => ({
    id: row.id,
    time: row.timestamp.toISOString(),
    ip: row.srcIpHash,
    type: row.attackType,
    prob: row.attackProb,
    blocked: row.attackProb >= BLOCK_THRESHOLD,
  }));

  return NextResponse.json(alerts);
}
