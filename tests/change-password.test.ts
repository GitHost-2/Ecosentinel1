/**
 * Cambiar contraseña con la sesión abierta (app/api/auth/change-password).
 *
 * Distinto de /reset (ese es SIN sesión, con token del correo): aquí el
 * usuario ya está dentro y demuestra ser él dando su contraseña ACTUAL. Lo
 * crítico a probar: que sin sesión no cambie nada, que una contraseña actual
 * equivocada no toque el hash, que la nueva se aplique de verdad, y que un
 * usuario no pueda tocar a otro.
 *
 * Rutas reales contra el Postgres LOCAL (ver tests/db-local.ts). Se salta si
 * no hay base.
 */
import { pool, closePool, databaseUnavailableReason } from "./db-local";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { POST as CHANGE } from "../app/api/auth/change-password/route";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";

let sinBase: string | false = "sin inicializar";
let anaId = 0;
let betoId = 0;

before(async () => {
  sinBase = await databaseUnavailableReason();
  if (sinBase) return;
  await pool.query("delete from users where email like 'test-cpw-%'");
  const ana = await pool.query(
    "insert into users (company,email,password_hash) values ('Ana CPW','test-cpw-ana@ejemplo.test',$1) returning id",
    [await bcrypt.hash("claveActual1", 10)],
  );
  const beto = await pool.query(
    "insert into users (company,email,password_hash) values ('Beto CPW','test-cpw-beto@ejemplo.test',$1) returning id",
    [await bcrypt.hash("betoClave1", 10)],
  );
  anaId = ana.rows[0].id;
  betoId = beto.rows[0].id;
});

after(async () => { await closePool(); });

function prueba(nombre: string, cuerpo: () => Promise<void> | void) {
  test(nombre, async (t) => {
    if (sinBase) { t.skip(sinBase); return; }
    await cuerpo();
  });
}

async function seedPassword(userId: number, plano: string) {
  await pool.query("update users set password_hash=$1 where id=$2", [await bcrypt.hash(plano, 10), userId]);
  // Limpiar el contador de rate limit de ESTE usuario para que las pruebas no
  // se bloqueen entre sí (10/15min es holgado, pero re-sembrar deja el caso
  // aislado de verdad).
  await pool.query("delete from rate_limit_counters where bucket_key=$1", [`changepw:user:${userId}`]);
}

function peticion(body: unknown, opciones: { userId?: number; cookieCruda?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opciones.cookieCruda !== undefined) headers.cookie = opciones.cookieCruda;
  else if (opciones.userId) headers.cookie = `${SESSION_COOKIE}=${createSessionToken(opciones.userId)}`;
  return new Request("http://localhost/api/auth/change-password", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function cambiar(body: unknown, opciones?: Parameters<typeof peticion>[1]) {
  const res = await CHANGE(peticion(body, opciones));
  return { status: res.status, body: await res.json() };
}

async function hashDe(userId: number): Promise<string> {
  const { rows } = await pool.query("select password_hash from users where id=$1", [userId]);
  return rows[0].password_hash as string;
}

prueba("sin sesión responde 401 y no cambia nada", async () => {
  await seedPassword(anaId, "claveActual1");
  const antes = await hashDe(anaId);
  const { status } = await cambiar({ currentPassword: "claveActual1", newPassword: "claveNueva2" });
  assert.equal(status, 401);
  assert.equal(await hashDe(anaId), antes, "un 401 no debe tocar el hash");
});

prueba("una cookie forjada responde 401", async () => {
  await seedPassword(anaId, "claveActual1");
  const token = createSessionToken(anaId);
  const manipulado = token.slice(0, -1) + (token.at(-1) === "a" ? "b" : "a");
  const { status } = await cambiar(
    { currentPassword: "claveActual1", newPassword: "claveNueva2" },
    { cookieCruda: `${SESSION_COOKIE}=${manipulado}` },
  );
  assert.equal(status, 401);
});

prueba("la contraseña actual equivocada da 400 y NO cambia el hash", async () => {
  await seedPassword(anaId, "claveActual1");
  const antes = await hashDe(anaId);
  const { status, body } = await cambiar(
    { currentPassword: "noEsLaActual9", newPassword: "claveNueva2" },
    { userId: anaId },
  );
  assert.equal(status, 400);
  assert.match(body.error, /actual/i);
  assert.equal(await hashDe(anaId), antes, "con la actual mal, el hash no se toca");
});

prueba("la nueva contraseña muy corta se rechaza (política)", async () => {
  await seedPassword(anaId, "claveActual1");
  const { status } = await cambiar({ currentPassword: "claveActual1", newPassword: "corta" }, { userId: anaId });
  assert.equal(status, 400);
});

prueba("la nueva igual a la actual se rechaza", async () => {
  await seedPassword(anaId, "claveActual1");
  const { status, body } = await cambiar(
    { currentPassword: "claveActual1", newPassword: "claveActual1" },
    { userId: anaId },
  );
  assert.equal(status, 400);
  assert.match(body.error, /distinta/i);
});

prueba("un cambio válido actualiza el hash de verdad", async () => {
  await seedPassword(anaId, "claveActual1");
  const { status, body } = await cambiar(
    { currentPassword: "claveActual1", newPassword: "claveNuevaSegura2" },
    { userId: anaId },
  );
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const nuevo = await hashDe(anaId);
  assert.ok(await bcrypt.compare("claveNuevaSegura2", nuevo), "la nueva contraseña debe autenticar");
  assert.equal(await bcrypt.compare("claveActual1", nuevo), false, "la vieja ya no");
});

prueba("el cambio solo afecta al usuario de la sesión, no a otro", async () => {
  await seedPassword(anaId, "claveActual1");
  await seedPassword(betoId, "betoClave1");
  const betoAntes = await hashDe(betoId);
  await cambiar({ currentPassword: "claveActual1", newPassword: "otraClave3" }, { userId: anaId });
  assert.equal(await hashDe(betoId), betoAntes, "cambiar la de Ana no debe tocar la de Beto");
});

prueba("faltar un campo da 400", async () => {
  await seedPassword(anaId, "claveActual1");
  const { status } = await cambiar({ currentPassword: "claveActual1" }, { userId: anaId });
  assert.equal(status, 400);
});
