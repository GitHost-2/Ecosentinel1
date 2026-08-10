import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_DASHBOARD_URL } from "./email";

/**
 * Lógica pura del flujo "olvidé mi contraseña".
 *
 * Vive aparte de las rutas a propósito: todo lo que se puede decidir sin base
 * de datos (generar el token, hashearlo, decidir si sirve, validar la política
 * de contraseña, armar el enlace) se prueba sin Postgres y sin red, y las
 * rutas quedan reducidas a orquestar.
 */

/** 32 bytes = 256 bits de entropía. Se transporta en hexadecimal (64 chars). */
export const RESET_TOKEN_BYTES = 32;

/** Una hora. Suficiente para leer el correo, corto para un enlace filtrado. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Misma política mínima que `/api/auth/register`. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Tope superior. bcrypt solo mira los primeros 72 BYTES de la contraseña
 * (bcryptjs trunca en silencio), así que una contraseña larguísima no aporta
 * seguridad y sí permitiría mandar megabytes a un endpoint que hace hashing
 * deliberadamente lento.
 */
export const MAX_PASSWORD_LENGTH = 128;

/** Token CRUDO: es lo único que ve el usuario, y solo viaja en su correo. */
export function generateResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString("hex");
}

/**
 * Lo que SÍ se guarda en la base.
 *
 * SHA-256 a secas (no bcrypt) porque esto no es una contraseña humana: son 32
 * bytes aleatorios, indistinguibles por fuerza bruta, así que un hash rápido no
 * abre nada. Y tiene que ser rápido y determinista para poder buscarlo por
 * índice único en vez de recorrer la tabla comparando.
 */
export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Filtro barato de forma antes de tocar la base (64 chars hex). */
export function isWellFormedResetToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === RESET_TOKEN_BYTES * 2 &&
    /^[0-9a-f]+$/.test(value)
  );
}

/** Mensaje de error de la política de contraseña, o null si cumple. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `La contraseña no puede pasar de ${MAX_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

/** Lo mínimo que hace falta de una fila de `password_reset_tokens` para juzgarla. */
export interface ResetTokenState {
  expiresAt: Date;
  usedAt: Date | null;
}

export type ResetTokenRejection = "no-encontrado" | "ya-usado" | "expirado";

/**
 * Por qué NO sirve un token, o null si sirve.
 *
 * El motivo es para el log del servidor; al cliente se le devuelve siempre el
 * mismo texto (ver `MENSAJE_TOKEN_INVALIDO`): distinguir "no existe" de
 * "expiró" le diría a quien prueba tokens al azar cuándo acertó uno.
 */
export function resetTokenRejection(
  row: ResetTokenState | null | undefined,
  now: Date = new Date(),
): ResetTokenRejection | null {
  if (!row) return "no-encontrado";
  if (row.usedAt !== null && row.usedAt !== undefined) return "ya-usado";
  if (row.expiresAt.getTime() <= now.getTime()) return "expirado";
  return null;
}

/** Único texto que ve el cliente cuando el enlace no sirve, sea cual sea el motivo. */
export const MENSAJE_TOKEN_INVALIDO =
  "El enlace no es válido o ya expiró. Solicita uno nuevo.";

/** Respuesta invariable de `/api/auth/forgot`: no revela si el correo existe. */
export const MENSAJE_FORGOT_GENERICO =
  "Si el correo existe, enviamos instrucciones para restablecer la contraseña.";

/**
 * Origen del sitio para armar el enlace del correo.
 *
 * `DASHBOARD_URL` apunta al PANEL (".../dashboard"), no a la raíz, así que
 * concatenarle "/reset" daría ".../dashboard/reset". Se le quita ese sufijo
 * para quedarnos con el origen. Si algún día se configura la variable con la
 * raíz a secas, esto sigue funcionando.
 */
export function siteBaseUrl(): string {
  const raw = (process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL).trim();
  return raw.replace(/\/+$/, "").replace(/\/dashboard$/, "");
}

/** Enlace que se manda por correo. El token CRUDO solo existe aquí y en el correo. */
export function resetPasswordUrl(rawToken: string): string {
  return `${siteBaseUrl()}/reset?token=${encodeURIComponent(rawToken)}`;
}

/** Momento de expiración de un token emitido ahora. */
export function resetTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + RESET_TOKEN_TTL_MS);
}
