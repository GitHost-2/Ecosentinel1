import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { users, passwordResetTokens } from "@/db/schema";
import {
  MENSAJE_TOKEN_INVALIDO,
  hashResetToken,
  isWellFormedResetToken,
  passwordPolicyError,
  resetTokenRejection,
} from "@/lib/password-reset";
import { LIMITS, checkRateLimitSafe, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset  {token, password}
 *
 * Canjea el token que se mandó por correo en `/api/auth/forgot`.
 *
 * Todos los motivos por los que un token no sirve —no existe, ya se usó,
 * caducó— devuelven el MISMO 400 con el MISMO texto. Distinguirlos le diría a
 * quien prueba tokens cuándo dio con uno real (aunque estuviera vencido).
 */

function tokenInvalido() {
  return NextResponse.json({ error: MENSAJE_TOKEN_INVALIDO }, { status: 400 });
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  const byIp = await checkRateLimitSafe({ key: `reset:ip:${ip}`, ...LIMITS.passwordResetPerIp });
  if (!byIp.allowed) {
    console.warn(`[auth/reset] rate limit por IP alcanzado. ip=${ip} intentos=${byIp.count}`);
    return tooManyRequests(
      "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
      byIp.retryAfterSeconds,
    );
  }

  const body = await request.json().catch(() => null);
  const rawToken = body?.token;
  const password = typeof body?.password === "string" ? body.password : "";

  // Filtro de forma antes de tocar la base: cualquier cosa que no sean 64
  // caracteres hex no puede ser un token nuestro.
  if (!isWellFormedResetToken(rawToken)) return tokenInvalido();

  // La política se comprueba ANTES de reclamar el token: si la contraseña no
  // cumple, el enlace debe seguir sirviendo para reintentar. Este mensaje sí
  // es específico — habla de la contraseña que el usuario acaba de escribir,
  // no del token, así que no filtra nada.
  const errorPolitica = passwordPolicyError(password);
  if (errorPolitica) {
    return NextResponse.json({ error: errorPolitica }, { status: 400 });
  }

  const [fila] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, hashResetToken(rawToken)))
    .limit(1);

  const motivo = resetTokenRejection(fila, new Date());
  if (motivo) {
    console.warn(`[auth/reset] token rechazado (${motivo})`);
    return tokenInvalido();
  }

  // Reclamar el token de forma ATÓMICA antes de tocar la contraseña. El
  // `used_at IS NULL` dentro del propio UPDATE es lo que hace que el enlace
  // sea de un solo uso de verdad: con dos peticiones simultáneas, Postgres
  // resuelve el conflicto en la fila y solo una recibe RETURNING con datos.
  // Comprobarlo antes con un SELECT y actualizar después dejaría una ventana
  // en la que las dos pasan.
  const reclamado = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.id, fila.id), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id, userId: passwordResetTokens.userId });

  if (reclamado.length === 0) {
    console.warn("[auth/reset] carrera perdida: el token ya se había reclamado");
    return tokenInvalido();
  }

  // Mismo hashing que register y login: bcrypt con coste 10.
  const passwordHash = await bcrypt.hash(password, 10);
  const actualizado = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, reclamado[0].userId))
    .returning({ id: users.id });

  if (actualizado.length === 0) {
    // El usuario desapareció entre el SELECT y el UPDATE. El token ya quedó
    // quemado, que es el lado seguro del fallo.
    console.error("[auth/reset] el token apuntaba a un usuario inexistente");
    return tokenInvalido();
  }

  // Cambiar la contraseña invalida el resto de enlaces vivos de esa cuenta:
  // si alguien pidió varios, ninguno debe seguir sirviendo después.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.userId, reclamado[0].userId),
        ne(passwordResetTokens.id, reclamado[0].id),
        isNull(passwordResetTokens.usedAt),
      ),
    );

  // NOTA: las sesiones abiertas NO se cierran. La sesión es una cookie firmada
  // con HMAC y sin estado en el servidor (lib/session.ts), así que no hay lista
  // que revocar. Si eso importara, habría que añadir un contador de versión de
  // sesión por usuario y meterlo en el payload firmado.
  return NextResponse.json({
    ok: true,
    message: "Tu contraseña se actualizó. Ya puedes iniciar sesión.",
  });
}
