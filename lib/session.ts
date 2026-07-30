import { createHmac, timingSafeEqual } from "node:crypto";

// Clave de firma de sesiones DERIVADA de INGEST_HMAC_SECRET con una
// etiqueta propia (separación de dominio criptográfico): así el mismo
// secreto no se reutiliza tal cual para firmar sesiones y para hashear
// API keys/IPs, y no hace falta configurar otra variable de entorno
// (una nueva variable rompería producción hasta agregarla a mano).
const ROOT_SECRET = process.env.INGEST_HMAC_SECRET;
if (!ROOT_SECRET) {
  throw new Error("Falta INGEST_HMAC_SECRET (necesario para firmar sesiones). Ver .env.example");
}
const SESSION_KEY = createHmac("sha256", ROOT_SECRET).update("ecosentinel-session-v1").digest();

export const SESSION_COOKIE = "ecosentinel_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 días

function sign(payload: string) {
  return createHmac("sha256", SESSION_KEY).update(payload).digest("hex");
}

/** Token de sesión: "<userId>.<expiraEnMs>.<firma>" */
export function createSessionToken(userId: number) {
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawUserId, rawExpiry, signature] = parts;

  const expected = sign(`${rawUserId}.${rawExpiry}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  const userId = Number(rawUserId);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

export function sessionCookieHeader(token: string) {
  // HttpOnly: inaccesible a JS, así un XSS no puede robar la sesión.
  // SameSite=Lax: no viaja en peticiones cross-site (mitiga CSRF).
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Devuelve el id del usuario autenticado, o null si no hay sesión válida. */
export function getSessionUserId(request: Request): number | null {
  return verifySessionToken(readCookie(request, SESSION_COOKIE));
}
