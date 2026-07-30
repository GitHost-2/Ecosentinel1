import { NextResponse, after } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSessionToken, sessionCookieHeader } from "@/lib/session";
import {
  LIMITS,
  checkRateLimitSafe,
  clientIp,
  purgeExpiredCounters,
  shouldPurge,
  tooManyRequests,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  // Rate limiting ANTES de tocar la base y ANTES del bcrypt: sin esto, este
  // endpoint permitía fuerza bruta ilimitada, y cada intento costaba una query
  // más un bcrypt.compare (deliberadamente lento).
  const ip = clientIp(request);
  const byIp = await checkRateLimitSafe({
    key: `login:ip:${ip}`,
    ...LIMITS.loginPerIp,
  });
  if (!byIp.allowed) {
    console.warn(`[auth/login] rate limit por IP alcanzado. ip=${ip} intentos=${byIp.count}`);
    return tooManyRequests(
      "Demasiados intentos de inicio de sesión. Espera unos minutos e inténtalo de nuevo.",
      byIp.retryAfterSeconds,
    );
  }

  if (!email || !password) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos." }, { status: 401 });
  }

  // Segundo cubo, por cuenta: cubre el ataque distribuido desde muchas IPs
  // contra un solo correo, que el límite por IP no ve.
  const byEmail = await checkRateLimitSafe({
    key: `login:email:${email}`,
    ...LIMITS.loginPerEmail,
  });
  if (!byEmail.allowed) {
    console.warn(`[auth/login] rate limit por correo alcanzado. intentos=${byEmail.count}`);
    return tooManyRequests(
      "Demasiados intentos de inicio de sesión para esta cuenta. Espera unos minutos e inténtalo de nuevo.",
      byEmail.retryAfterSeconds,
    );
  }

  if (shouldPurge()) {
    after(() => purgeExpiredCounters());
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos." }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos." }, { status: 401 });
  }

  // Sesión de servidor en cookie firmada (HttpOnly). Antes la "sesión" vivía
  // solo en sessionStorage del navegador, así que el servidor no autenticaba
  // nada: las rutas de datos quedaban abiertas a cualquiera.
  const res = NextResponse.json({
    id: user.id,
    company: user.company,
    email: user.email,
    plan: user.plan,
    profile: user.profile,
  });
  res.headers.set("Set-Cookie", sessionCookieHeader(createSessionToken(user.id)));
  return res;
}
