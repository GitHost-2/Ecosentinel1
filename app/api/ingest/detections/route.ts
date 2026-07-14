import { NextResponse } from "next/server";
import { db } from "@/db";
import { detections } from "@/db/schema";
import { authenticateDevice, hashSourceIp } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

const VALID_ATTACK_TYPES = new Set([
  "Ransomware",
  "DDoS",
  "Port Scanning",
  "Botnet Mirai",
  "Brute Force",
  "Spoofing",
]);

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
  const deviceId = await authenticateDevice(request);
  if (!deviceId) {
    return NextResponse.json({ error: "API key inválida o ausente." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const attackProb = Number(body.attack_prob);
  const attackType = String(body.attack_type || "");
  const protocol = String(body.protocol || "");
  const srcIp = String(body.src_ip || "");
  const dstPort = Number(body.dst_port);
  const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

  if (
    Number.isNaN(attackProb) || attackProb < 0 || attackProb > 1 ||
    !VALID_ATTACK_TYPES.has(attackType) ||
    !protocol ||
    !srcIp ||
    !Number.isInteger(dstPort) || dstPort < 0 || dstPort > 65535 ||
    Number.isNaN(timestamp.getTime())
  ) {
    return NextResponse.json({ error: "Datos de detección inválidos." }, { status: 400 });
  }

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

  return NextResponse.json({ id: row.id }, { status: 201 });
}
