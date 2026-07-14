import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { devices } from "@/db/schema";

// Secreto del servidor para hashear API keys de dispositivo e IPs de
// origen. NUNCA usar un SHA-256 "pelón" para la IP: el espacio de
// direcciones IPv4 es tan chico (~4 mil millones) que un hash sin llave
// se puede invertir por fuerza bruta en minutos. HMAC con este secreto
// lo evita. Debe vivir SOLO en variables de entorno del servidor.
const SECRET = process.env.INGEST_HMAC_SECRET;
if (!SECRET) {
  throw new Error(
    "Falta INGEST_HMAC_SECRET. Genera uno con `openssl rand -hex 32` y agrégalo a tus variables de entorno.",
  );
}

export function generateApiKey() {
  const raw = randomBytes(32).toString("hex"); // se le da UNA vez al dueño de la RPi
  const hash = hmac(raw); // esto es lo único que se guarda en la BD
  return { raw, hash };
}

export function hmac(value: string) {
  return createHmac("sha256", SECRET!).update(value).digest("hex");
}

/** Hashea una IP de origen antes de guardarla (privacidad de los clientes). */
export function hashSourceIp(ip: string) {
  return hmac(ip);
}

/**
 * Verifica el header `Authorization: Bearer <api_key>` de una petición de
 * ingesta contra `devices.api_key_hash` y devuelve el id del dispositivo,
 * o null si la key es inválida/falta.
 */
export async function authenticateDevice(request: Request): Promise<number | null> {
  const authHeader = request.headers.get("authorization") || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  const tokenHash = hmac(token);
  const [device] = await db
    .select({ id: devices.id, apiKeyHash: devices.apiKeyHash })
    .from(devices)
    .where(eq(devices.apiKeyHash, tokenHash))
    .limit(1);

  if (!device) return null;

  // Comparación en tiempo constante (aunque ya comparamos hashes
  // completos, es una buena práctica no depender de `===` para secretos).
  const a = Buffer.from(tokenHash);
  const b = Buffer.from(device.apiKeyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return device.id;
}
