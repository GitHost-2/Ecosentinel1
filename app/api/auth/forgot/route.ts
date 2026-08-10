import { NextResponse, after } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users, passwordResetTokens } from "@/db/schema";
import { sendPasswordResetEmail } from "@/lib/email";
import {
  MENSAJE_FORGOT_GENERICO,
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  resetPasswordUrl,
  resetTokenExpiry,
} from "@/lib/password-reset";
import {
  LIMITS,
  checkRateLimitSafe,
  clientIp,
  purgeExpiredCounters,
  shouldPurge,
  tooManyRequests,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot  {email}
 *
 * SIEMPRE responde 200 con el mismo texto, exista o no la cuenta. Un 404 (o
 * un mensaje distinto) convertiría este endpoint en un enumerador de correos
 * registrados, que es justo lo que la respuesta genérica evita.
 *
 * La única respuesta distinta es el 429 del rate limiting, y ese NO filtra
 * nada: el contador se incrementa igual exista o no la cuenta, así que el
 * atacante ve 429 en ambos casos.
 */

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function respuestaGenerica() {
  // `no-store` para que ningún proxy cachee la respuesta de un correo concreto.
  return NextResponse.json(
    { message: MENSAJE_FORGOT_GENERICO },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  // Freno por IP ANTES de tocar la base y ANTES de mandar nada: cada petición
  // aceptada acaba en un correo a un tercero.
  const ip = clientIp(request);
  const byIp = await checkRateLimitSafe({ key: `forgot:ip:${ip}`, ...LIMITS.forgotPerIp });
  if (!byIp.allowed) {
    console.warn(`[auth/forgot] rate limit por IP alcanzado. ip=${ip} intentos=${byIp.count}`);
    return tooManyRequests(
      "Demasiadas solicitudes de restablecimiento. Espera unos minutos e inténtalo de nuevo.",
      byIp.retryAfterSeconds,
    );
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  // Un correo mal formado ni siquiera llega a la base, pero la respuesta es la
  // misma: el cliente no puede distinguir "inválido" de "no registrado".
  if (!email || email.length > 254 || !isEmail(email)) {
    return respuestaGenerica();
  }

  const byEmail = await checkRateLimitSafe({ key: `forgot:email:${email}`, ...LIMITS.forgotPerEmail });
  if (!byEmail.allowed) {
    console.warn(`[auth/forgot] rate limit por correo alcanzado. intentos=${byEmail.count}`);
    return tooManyRequests(
      "Ya se enviaron varias solicitudes para este correo. Espera un rato e inténtalo de nuevo.",
      byEmail.retryAfterSeconds,
    );
  }

  if (shouldPurge()) {
    after(() => purgeExpiredCounters());
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    // Cuenta inexistente: se responde exactamente igual y no se manda nada.
    console.info("[auth/forgot] solicitud para un correo no registrado (respuesta genérica)");
    return respuestaGenerica();
  }

  // Invalidar los enlaces anteriores que sigan vivos: pedir uno nuevo debe
  // dejar UNO válido, no una colección de puertas abiertas.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));

  const rawToken = generateResetToken();
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    // Solo el hash. El token crudo vive únicamente en la memoria de esta
    // petición y en el correo del usuario.
    tokenHash: hashResetToken(rawToken),
    expiresAt: resetTokenExpiry(),
  });

  const enviar = async () => {
    const resultado = await sendPasswordResetEmail({
      to: user.email,
      resetUrl: resetPasswordUrl(rawToken),
      expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
    });
    if (!resultado.ok) {
      // ⚠️ Lo más probable aquí es el sandbox de Resend: solo entrega a
      // eduardoedu12x@gmail.com (ver el comentario grande de lib/email.ts).
      // No se propaga al cliente: la respuesta ya salió y es genérica.
      console.error(`[auth/forgot] no se pudo enviar el correo de reset: ${resultado.error}`);
    }
  };

  // El envío va DESPUÉS de responder: así el tiempo de respuesta no depende de
  // la latencia de Resend, que es lo que convertiría el propio reloj en un
  // oráculo de "esta cuenta existe" pese a la respuesta genérica.
  try {
    after(enviar);
  } catch {
    // `after()` lanza fuera de un request scope (p. ej. en las pruebas, que
    // llaman al handler directamente). Ahí se espera el envío, que sin
    // RESEND_API_KEY retorna de inmediato.
    await enviar();
  }

  return respuestaGenerica();
}
