import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSessionToken, sessionCookieHeader } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos." }, { status: 401 });
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
