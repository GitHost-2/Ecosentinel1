import { NextResponse, after } from "next/server";
import { db } from "@/db";
import { detections } from "@/db/schema";
import { authenticateDevice, hashSourceIp } from "@/lib/device-auth";
import { maybeSendAttackAlert } from "@/lib/alerts";

export const dynamic = "force-dynamic";

const VALID_ATTACK_TYPES = new Set([
  "Ransomware",
  "DDoS",
  "Port Scanning",
  "Botnet Mirai",
  "Brute Force",
  "Spoofing",
]);

// Mismo vocabulario que emite inference_engine.py en la RPi (info["proto"]):
// TCP / UDP / ICMP, con "OTHER" como fallback para el resto del tráfico.
const VALID_PROTOCOLS = new Set(["TCP", "UDP", "ICMP", "OTHER"]);

/**
 * Ingesta de una detección real de la Raspberry Pi.
 *
 * Auth:   Authorization: Bearer <api_key del dispositivo>
 * Body:   {
 *   "attack_prob": 0.94,          // float 0-1, salida del modelo
 *   "attack_type": "Port Scanning", // una de las 6 familias soportadas
 *   "protocol": "TCP",            // capa de red: TCP/UDP/ICMP/...
 *   "src_ip": "192.168.1.57",     // IP real; el servidor la hashea (HMAC), nunca se guarda en texto plano
 *   "dst_port": 443,
 *   "timestamp": "2026-07-14T22:10:03Z" // opcional, default = ahora
 * }
 */
export async function POST(request: Request) {
  let deviceId: number | null;
  try {
    deviceId = await authenticateDevice(request);
  } catch (err) {
    console.error("[ingest/detections] fallo al autenticar dispositivo:", err);
    return NextResponse.json({ error: "Error interno al autenticar." }, { status: 500 });
  }
  if (!deviceId) {
    console.error("[ingest/detections] API key inválida o ausente. authHeader presente:", request.headers.has("authorization"));
    return NextResponse.json({ error: "API key inválida o ausente." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    console.error(`[ingest/detections] body no es JSON válido. deviceId=${deviceId}`);
    return NextResponse.json({ error: "Body inválido: se esperaba JSON." }, { status: 400 });
  }

  const attackProb = Number(body.attack_prob);
  const attackType = String(body.attack_type ?? "");
  const protocol = String(body.protocol ?? "").toUpperCase();
  const srcIp = String(body.src_ip ?? "");
  const dstPort = Number(body.dst_port);
  const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

  const fieldErrors: string[] = [];
  if (Number.isNaN(attackProb) || attackProb < 0 || attackProb > 1) {
    fieldErrors.push("attack_prob debe ser un número entre 0 y 1.");
  }
  if (!VALID_ATTACK_TYPES.has(attackType)) {
    fieldErrors.push(`attack_type debe ser uno de: ${[...VALID_ATTACK_TYPES].join(", ")}.`);
  }
  if (!VALID_PROTOCOLS.has(protocol)) {
    fieldErrors.push(`protocol debe ser uno de: ${[...VALID_PROTOCOLS].join(", ")}.`);
  }
  if (!srcIp) {
    fieldErrors.push("src_ip es requerido.");
  }
  if (!Number.isInteger(dstPort) || dstPort < 0 || dstPort > 65535) {
    fieldErrors.push("dst_port debe ser un entero entre 0 y 65535.");
  }
  if (Number.isNaN(timestamp.getTime())) {
    fieldErrors.push("timestamp inválido.");
  }

  if (fieldErrors.length > 0) {
    console.error(
      `[ingest/detections] payload inválido. deviceId=${deviceId} errores=${fieldErrors.join(" | ")} body=${JSON.stringify(body)}`,
    );
    return NextResponse.json({ error: "Datos de detección inválidos.", details: fieldErrors }, { status: 400 });
  }

  try {
    const [row] = await db
      .insert(detections)
      .values({
        deviceId,
        timestamp,
        attackProb,
        protocol,
        attackType,
        srcIpHash: hashSourceIp(srcIp),
        dstPort,
      })
      .returning({ id: detections.id });

    // Fuera de la respuesta a la RPi: nunca debe agregar latencia a la
    // ingesta ni hacer que un fallo de correo tumbe un 201 que ya es
    // válido (la detección ya está guardada).
    after(() =>
      maybeSendAttackAlert({
        deviceId,
        detectionId: row.id,
        attackType,
        attackProb,
        protocol,
        dstPort,
        timestamp,
      }),
    );

    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (err) {
    console.error(`[ingest/detections] fallo al insertar en DB. deviceId=${deviceId}:`, err);
    return NextResponse.json({ error: "Error interno al guardar la detección." }, { status: 500 });
  }
}
