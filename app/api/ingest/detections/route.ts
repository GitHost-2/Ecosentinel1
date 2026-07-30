import { NextResponse, after } from "next/server";
import { db } from "@/db";
import { detections } from "@/db/schema";
import { authenticateDevice, hashSourceIp } from "@/lib/device-auth";
import { maybeSendAttackAlert } from "@/lib/alerts";
import {
  LIMITS,
  checkRateLimitSafe,
  clientIp,
  purgeExpiredCounters,
  shouldPurge,
  tooManyRequests,
} from "@/lib/rate-limit";

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
 *   "src_ip": "a3f1c9d0e2b4d7f8",  // ya viene hasheada por la RPi (hash_ip());
 *                                  // el servidor aplica una segunda capa de HMAC (hashSourceIp())
 *   "dst_port": 443,
 *   "timestamp": "2026-07-14T22:10:03Z" // opcional, default = ahora
 * }
 */
export async function POST(request: Request) {
  // Cubo por IP ANTES de autenticar: cada intento con una key inválida cuesta
  // una query a la base, así que sin este freno se puede golpear la base sin
  // credenciales válidas. Deliberadamente holgado (la RPi legítima jamás lo
  // alcanza) — el freno fino va por dispositivo, más abajo.
  const ip = clientIp(request);
  const byIp = await checkRateLimitSafe({ key: `ingest:ip:${ip}`, ...LIMITS.ingestPerIp });
  if (!byIp.allowed) {
    console.warn(`[ingest/detections] rate limit por IP alcanzado. ip=${ip} peticiones=${byIp.count}`);
    return tooManyRequests("Demasiadas peticiones.", byIp.retryAfterSeconds);
  }

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

  // Cubo por dispositivo: si una API key se filtra, esto acota cuántas filas
  // puede meter en la base. Ver LIMITS.ingestPerDevice para por qué el número
  // es alto (un port scan real produce ~500 detecciones en 2 segundos).
  const byDevice = await checkRateLimitSafe({
    key: `ingest:device:${deviceId}`,
    ...LIMITS.ingestPerDevice,
  });
  if (!byDevice.allowed) {
    console.warn(
      `[ingest/detections] rate limit por dispositivo alcanzado. deviceId=${deviceId} peticiones=${byDevice.count}`,
    );
    return tooManyRequests("Demasiadas detecciones en el último minuto.", byDevice.retryAfterSeconds);
  }

  if (shouldPurge()) {
    after(() => purgeExpiredCounters());
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

    // Fuera de la respuesta: un fallo de correo no debe afectar el 201.
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
