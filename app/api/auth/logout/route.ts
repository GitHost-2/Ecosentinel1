import { NextResponse } from "next/server";
import { clearSessionCookieHeader } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Borra la cookie de sesión del servidor (el cliente además limpia sessionStorage). */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearSessionCookieHeader());
  return res;
}
