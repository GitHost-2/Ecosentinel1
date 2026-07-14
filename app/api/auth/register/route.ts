import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export const dynamic = "force-dynamic";

function isEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const company = typeof body?.company === "string" ? body.company.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const plan = typeof body?.plan === "string" ? body.plan : "Pro";
  const password = typeof body?.password === "string" ? body.password : "";

  if (company.length < 2 || !isEmail(email) || password.length < 8) {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: "Ese correo ya está registrado." }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(users)
    .values({ company, email, plan, passwordHash })
    .returning({ id: users.id, company: users.company, email: users.email, plan: users.plan, profile: users.profile });

  return NextResponse.json(user, { status: 201 });
}
