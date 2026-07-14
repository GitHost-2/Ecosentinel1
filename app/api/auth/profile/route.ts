import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export const dynamic = "force-dynamic";

const VALID_PROFILES = ["principiante", "intermedio", "avanzado"];

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const profile = typeof body?.profile === "string" ? body.profile : "";

  if (!email || !VALID_PROFILES.includes(profile)) {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }

  const [user] = await db
    .update(users)
    .set({ profile })
    .where(eq(users.email, email))
    .returning({ id: users.id, email: users.email, profile: users.profile });

  if (!user) {
    return NextResponse.json({ error: "Usuario no encontrado." }, { status: 404 });
  }

  return NextResponse.json(user);
}
