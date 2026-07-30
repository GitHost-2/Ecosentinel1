import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

const VALID_PROFILES = ["principiante", "intermedio", "avanzado"];

export async function PATCH(request: Request) {
  // Antes esta ruta aceptaba un `email` en el body y actualizaba a ESE
  // usuario sin verificar nada: cualquiera podía cambiarle el perfil a
  // cualquier cuenta con solo conocer su correo. Ahora el usuario sale de
  // la sesión y el `email` del body se ignora por completo.
  const userId = getSessionUserId(request);
  if (!userId) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const profile = typeof body?.profile === "string" ? body.profile : "";
  if (!VALID_PROFILES.includes(profile)) {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }

  const [user] = await db
    .update(users)
    .set({ profile })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email, profile: users.profile });

  if (!user) {
    return NextResponse.json({ error: "Usuario no encontrado." }, { status: 404 });
  }

  return NextResponse.json(user);
}
