import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSessionUserId } from "@/lib/session";
import { passwordPolicyError } from "@/lib/password-reset";
import { LIMITS, checkRateLimitSafe, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/change-password  { currentPassword, newPassword }
 *
 * Cambia la contraseña de la cuenta con la sesión ABIERTA. Distinta de
 * /api/auth/reset (que se hace SIN sesión, con el token del correo de
 * "olvidé mi contraseña"): aquí el usuario ya está dentro y demuestra que es
 * él pidiéndole su contraseña ACTUAL, no un token.
 *
 * Reutiliza la misma política de contraseña que el registro y el reset
 * (lib/password-reset.ts) y el mismo bcrypt coste 10 que login/register.
 */
export async function POST(request: Request) {
  const userId = getSessionUserId(request);
  if (!userId) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  // El límite va por usuario (no por IP): la sesión ya identifica la cuenta, y
  // lo que se quiere acotar es el intento de adivinar la contraseña actual
  // desde una sesión robada, cada intento con su bcrypt.compare.
  const rl = await checkRateLimitSafe({ key: `changepw:user:${userId}`, ...LIMITS.changePasswordPerUser });
  if (!rl.allowed) {
    console.warn(`[auth/change-password] rate limit alcanzado. user=${userId} intentos=${rl.count}`);
    return tooManyRequests(
      "Demasiados intentos de cambio de contraseña. Espera unos minutos e inténtalo de nuevo.",
      rl.retryAfterSeconds,
    );
  }

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Faltan datos." }, { status: 400 });
  }

  // La política de la contraseña NUEVA se comprueba antes de tocar la base ni
  // el bcrypt de verificación. Este mensaje sí es específico (habla de la
  // contraseña que el usuario acaba de escribir), no filtra nada de la cuenta.
  const errPolitica = passwordPolicyError(newPassword);
  if (errPolitica) {
    return NextResponse.json({ error: errPolitica }, { status: 400 });
  }

  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "La nueva contraseña debe ser distinta de la actual." },
      { status: 400 },
    );
  }

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    // La sesión apunta a un usuario que ya no existe (borrado). Es un 401
    // honesto: esa sesión ya no vale.
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const valida = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valida) {
    return NextResponse.json({ error: "La contraseña actual no es correcta." }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));

  // NOTA: igual que en /api/auth/reset, las sesiones abiertas NO se invalidan
  // (la cookie es HMAC sin estado en el servidor). La sesión actual sigue
  // siendo válida a propósito: quien cambia su contraseña no debería quedar
  // deslogueado. Si algún día importara revocar las demás, haría falta un
  // contador de versión de sesión por usuario en el payload firmado.
  return NextResponse.json({ ok: true, message: "Tu contraseña se actualizó correctamente." });
}
