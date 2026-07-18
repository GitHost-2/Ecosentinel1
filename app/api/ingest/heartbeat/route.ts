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
 *   "packets_processed": 18234,           // opcional, default 0. Paquetes
 *                                          // procesados DESDE el heartbeat
 *                                          // anterior (delta, no acumulado).
 *   "timestamp": "2026-07-14T22:10:03Z"   // opcional, default = ahora
 * }
 */
export async function POST(request: Request) {
  let deviceId: number | null;
  try {
    deviceId = await authenticateDevice(request);
  } catch (err) {
    console.error("[ingest/heartbeat] fallo al autenticar dispositivo:", err);
    return NextResponse.json({ error: "Error interno al autenticar." }, { status: 500 });
  }
  if (!deviceId) {
    console.error("[ingest/heartbeat] API key inválida o ausente. authHeader presente:", request.headers.has("authorization"));
    return NextResponse.json({ error: "API key inválida o ausente." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    console.error(`[ingest/heartbeat] body no es JSON válido. deviceId=${deviceId}`);
    return NextResponse.json({ error: "Body inválido: se esperaba JSON." }, { status: 400 });
  }

  const cpuPct = Number(body.cpu_pct);
  const ramPct = Number(body.ram_pct);
  const modeloVersion = String(body.modelo_version ?? "");
  const packetsProcessed = body.packets_processed === undefined ? 0 : Number(body.packets_processed);
  const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

  const fieldErrors: string[] = [];
  if (Number.isNaN(cpuPct) || cpuPct < 0 || cpuPct > 100) {
    fieldErrors.push("cpu_pct debe ser un número entre 0 y 100.");
  }
  if (Number.isNaN(ramPct) || ramPct < 0 || ramPct > 100) {
    fieldErrors.push("ram_pct debe ser un número entre 0 y 100.");
  }
  if (!modeloVersion) {
    fieldErrors.push("modelo_version es requerido.");
  }
  if (!Number.isInteger(packetsProcessed) || packetsProcessed < 0) {
    fieldErrors.push("packets_processed debe ser un entero >= 0.");
  }
  if (Number.isNaN(timestamp.getTime())) {
    fieldErrors.push("timestamp inválido.");
  }

  if (fieldErrors.length > 0) {
    console.error(
      `[ingest/heartbeat] payload inválido. deviceId=${deviceId} errores=${fieldErrors.join(" | ")} body=${JSON.stringify(body)}`,
    );
    return NextResponse.json({ error: "Datos de heartbeat inválidos.", details: fieldErrors }, { status: 400 });
  }

  try {
    await db.insert(deviceHeartbeats).values({ deviceId, timestamp, cpuPct, ramPct, modeloVersion, packetsProcessed });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error(`[ingest/heartbeat] fallo al insertar en DB. deviceId=${deviceId}:`, err);
    return NextResponse.json({ error: "Error interno al guardar el heartbeat." }, { status: 500 });
  }
}
