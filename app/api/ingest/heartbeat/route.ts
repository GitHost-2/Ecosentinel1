import { NextResponse } from "next/server";
import { db } from "@/db";
import { deviceHeartbeats } from "@/db/schema";
import { authenticateDevice } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

/**
 * Ingesta de un heartbeat (salud) de la Raspberry Pi.
 *
 * Auth:   Authorization: Bearer <api_key del dispositivo>
 * Body:   {
 *   "cpu_pct": 34.2,
 *   "ram_pct": 51.8,
 *   "modelo_version": "rf-v1.3",
 *   "timestamp": "2026-07-14T22:10:03Z" // opcional, default = ahora
 * }
 */
export async function POST(request: Request) {
  const deviceId = await authenticateDevice(request);
  if (!deviceId) {
    return NextResponse.json({ error: "API key inválida o ausente." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const cpuPct = Number(body.cpu_pct);
  const ramPct = Number(body.ram_pct);
  const modeloVersion = String(body.modelo_version || "");
  const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

  if (
    Number.isNaN(cpuPct) || cpuPct < 0 || cpuPct > 100 ||
    Number.isNaN(ramPct) || ramPct < 0 || ramPct > 100 ||
    !modeloVersion ||
    Number.isNaN(timestamp.getTime())
  ) {
    return NextResponse.json({ error: "Datos de heartbeat inválidos." }, { status: 400 });
  }

  await db.insert(deviceHeartbeats).values({ deviceId, timestamp, cpuPct, ramPct, modeloVersion });

  return NextResponse.json({ ok: true }, { status: 201 });
}
