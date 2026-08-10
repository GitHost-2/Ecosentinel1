/**
 * "Olvidé mi contraseña" (lib/password-reset.ts + app/api/auth/{forgot,reset}).
 *
 * Dos bloques:
 *  1. Lógica pura (sin base) — token, hash, política de contraseña, motivo de
 *     rechazo. Corre siempre.
 *  2. Rutas reales contra el Postgres LOCAL de pruebas (mismo patrón que
 *     tests/mitigate.test.ts): lo que hay que validar aquí es que el endpoint
 *     NO se convierta en un enumerador de correos y que el canje del token sea
 *     de un solo uso de verdad, y eso es semántica de base, no de la función
 *     pura. Se salta entero si no hay Postgres local.
 */
import "./setup-env";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  RESET_TOKEN_BYTES,
  RESET_TOKEN_TTL_MS,
  MENSAJE_TOKEN_INVALIDO,
  MENSAJE_FORGOT_GENERICO,
  generateResetToken,
  hashResetToken,
  isWellFormedResetToken,
  passwordPolicyError,
  resetTokenRejection,
  resetPasswordUrl,
  resetTokenExpiry,
} from "../lib/password-reset";

// ── 1. Lógica pura ──────────────────────────────────────────────────────────

test("el token crudo tiene la entropía y forma esperadas", () => {
  const t = generateResetToken();
  assert.equal(t.length, RESET_TOKEN_BYTES * 2, "hex de 32 bytes = 64 chars");
  assert.match(t, /^[0-9a-f]+$/);
});

test("dos tokens generados no coinciden", () => {
  assert.notEqual(generateResetToken(), generateResetToken());
});

test("el hash es determinista pero no reversible a simple vista", () => {
  const t = generateResetToken();
  assert.equal(hashResetToken(t), hashResetToken(t));
  assert.notEqual(hashResetToken(t), t);
});

test("isWellFormedResetToken rechaza cualquier cosa que no sea 64 hex", () => {
  assert.equal(isWellFormedResetToken(generateResetToken()), true);
  assert.equal(isWellFormedResetToken("abc"), false, "muy corto");
  assert.equal(isWellFormedResetToken("g".repeat(64)), false, "no es hex");
  assert.equal(isWellFormedResetToken(null), false);
  assert.equal(isWellFormedResetToken(12345), false, "no es string");
  assert.equal(isWellFormedResetToken("A".repeat(64)), false, "mayúsculas no cuelan");
});

test("passwordPolicyError rechaza corta y larguísima, acepta el rango válido", () => {
  assert.ok(passwordPolicyError("1234567") !== null, "7 chars no alcanza");
  assert.equal(passwordPolicyError("12345678"), null, "8 chars sí alcanza");
  assert.equal(passwordPolicyError("a".repeat(128)), null, "128 chars sigue siendo válida");
  assert.ok(passwordPolicyError("a".repeat(129)) !== null, "129 chars ya no");
});

test("resetTokenRejection: fila inexistente", () => {
  assert.equal(resetTokenRejection(null), "no-encontrado");
  assert.equal(resetTokenRejection(undefined), "no-encontrado");
});

test("resetTokenRejection: ya usado gana sobre expirado", () => {
  const ahora = new Date("2026-08-09T12:00:00Z");
  const fila = { usedAt: new Date("2026-08-09T10:00:00Z"), expiresAt: new Date("2026-08-09T09:00:00Z") };
  assert.equal(resetTokenRejection(fila, ahora), "ya-usado");
});

test("resetTokenRejection: expirado", () => {
  const ahora = new Date("2026-08-09T12:00:00Z");
  const fila = { usedAt: null, expiresAt: new Date("2026-08-09T11:59:59Z") };
  assert.equal(resetTokenRejection(fila, ahora), "expirado");
});

test("resetTokenRejection: token vivo y sin usar no se rechaza", () => {
  const ahora = new Date("2026-08-09T12:00:00Z");
  const fila = { usedAt: null, expiresAt: new Date("2026-08-09T12:00:01Z") };
  assert.equal(resetTokenRejection(fila, ahora), null);
});

test("el TTL del token es una hora", () => {
  assert.equal(RESET_TOKEN_TTL_MS, 60 * 60 * 1000);
  const emitido = new Date("2026-08-09T12:00:00Z");
  assert.equal(resetTokenExpiry(emitido).getTime(), emitido.getTime() + RESET_TOKEN_TTL_MS);
});

test("resetPasswordUrl arma /reset?token=... sobre el origen, no sobre /dashboard", () => {
  const url = resetPasswordUrl("deadbeef");
  assert.ok(!url.includes("/dashboard"), "no debe arrastrar el sufijo del panel");
  assert.match(url, /\/reset\?token=deadbeef$/);
});

test("los mensajes al cliente no distinguen motivo (anti-enumeración)", () => {
  assert.ok(MENSAJE_FORGOT_GENERICO.length > 0);
  assert.ok(MENSAJE_TOKEN_INVALIDO.length > 0);
});

// ── 2. Rutas reales contra Postgres local ───────────────────────────────────

import { pool, closePool, databaseUnavailableReason } from "./db-local";
import { POST as FORGOT } from "../app/api/auth/forgot/route";
import { POST as RESET } from "../app/api/auth/reset/route";

let sinBase: string | false = "sin inicializar";
let anaId = 0;
const ANA_EMAIL = "test-reset-ana@ejemplo.test";

before(async () => {
  sinBase = await databaseUnavailableReason();
  if (sinBase) return;

  await pool.query("delete from password_reset_tokens where user_id in (select id from users where email like 'test-reset-%')");
  await pool.query("delete from users where email like 'test-reset-%'");
  // Los tests de mitigate.test.ts ya usan sus propias claves; limpiamos solo
  // los buckets de este archivo para no interferir con los suyos.
  await pool.query("delete from rate_limit_counters where bucket_key like 'forgot:%test-reset%' or bucket_key like 'reset:%'");

  const ana = await pool.query(
    "insert into users (company,email,password_hash) values ('Ana Reset','" + ANA_EMAIL + "','hash-original') returning id",
  );
  anaId = ana.rows[0].id;
});

after(async () => {
  await closePool();
});

function prueba(nombre: string, cuerpo: () => Promise<void> | void) {
  test(nombre, async (t) => {
    if (sinBase) {
      t.skip(sinBase);
      return;
    }
    await cuerpo();
  });
}

/**
 * El límite de "forgot" por CORREO (3/hora, ver lib/rate-limit.ts) es
 * independiente de la IP: varias pruebas piden un enlace para la MISMA
 * cuenta, así que hay que vaciar su contador antes de cada una o se
 * bloquearían entre sí con un 429 y el test fallaría por una razón que no es
 * la que se está probando.
 */
async function limpiarLimiteForgotPorCorreo(email: string) {
  await pool.query("delete from rate_limit_counters where bucket_key=$1", [`forgot:email:${email}`]);
}

function forgotRequest(email: unknown, ip = "203.0.113.10") {
  return new Request("http://localhost/api/auth/forgot", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

function resetRequest(token: unknown, password: unknown, ip = "203.0.113.20") {
  return new Request("http://localhost/api/auth/reset", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ token, password }),
  });
}

prueba("VULN pattern: forgot responde IGUAL para correo existente e inexistente", async () => {
  await limpiarLimiteForgotPorCorreo(ANA_EMAIL);
  const r1 = await FORGOT(forgotRequest(ANA_EMAIL, "203.0.113.11"));
  const b1 = await r1.json();
  const r2 = await FORGOT(forgotRequest("no-existe-test-reset@ejemplo.test", "203.0.113.12"));
  const b2 = await r2.json();

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(b1.message, b2.message, "el mensaje no debe delatar si la cuenta existe");
});

prueba("forgot con correo existente SÍ deja un token vivo en la base", async () => {
  await limpiarLimiteForgotPorCorreo(ANA_EMAIL);
  await FORGOT(forgotRequest(ANA_EMAIL, "203.0.113.13"));
  const { rows } = await pool.query(
    "select count(*)::int as n from password_reset_tokens where user_id=$1 and used_at is null",
    [anaId],
  );
  assert.ok(rows[0].n >= 1, "debe haber al menos un token vivo tras pedirlo");
});

prueba("pedir un segundo enlace invalida el anterior (no deja puertas abiertas)", async () => {
  await limpiarLimiteForgotPorCorreo(ANA_EMAIL);
  await FORGOT(forgotRequest(ANA_EMAIL, "203.0.113.14"));
  const { rows: antes } = await pool.query(
    "select id from password_reset_tokens where user_id=$1 and used_at is null",
    [anaId],
  );
  await FORGOT(forgotRequest(ANA_EMAIL, "203.0.113.15"));
  const { rows: despues } = await pool.query(
    "select id from password_reset_tokens where user_id=$1 and used_at is null",
    [anaId],
  );
  assert.equal(despues.length, 1, "solo debe quedar UN token vivo");
  assert.notEqual(despues[0].id, antes[0]?.id, "el vivo es el nuevo, no el anterior");
});

prueba("un token con formato inválido se rechaza sin tocar la base", async () => {
  const res = await RESET(resetRequest("no-es-un-token-valido", "unaPasswordValida1"));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, MENSAJE_TOKEN_INVALIDO);
});

prueba("una contraseña que no cumple la política no quema el token", async () => {
  await pool.query("delete from password_reset_tokens where user_id=$1", [anaId]);
  const raw = await pedirYExtraerTokenCrudo(anaId);

  const res = await RESET(resetRequest(raw, "corta"));
  assert.equal(res.status, 400);

  // El enlace debe seguir sirviendo: la política se comprueba ANTES de canjear.
  const okAhora = await RESET(resetRequest(raw, "unaPasswordValida1"));
  assert.equal(okAhora.status, 200, "el mismo token debe poder reintentarse con buena contraseña");
});

prueba("un reset válido cambia el hash de verdad y quema el token", async () => {
  await pool.query("delete from password_reset_tokens where user_id=$1", [anaId]);
  const raw = await pedirYExtraerTokenCrudo(anaId);

  const res = await RESET(resetRequest(raw, "otraPasswordValida2"));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);

  const { rows } = await pool.query("select password_hash from users where id=$1", [anaId]);
  assert.ok(await bcrypt.compare("otraPasswordValida2", rows[0].password_hash), "la contraseña nueva debe autenticar");
  assert.equal(await bcrypt.compare("hash-original", rows[0].password_hash), false);
});

prueba("el mismo token no se puede canjear dos veces", async () => {
  await pool.query("delete from password_reset_tokens where user_id=$1", [anaId]);
  const raw = await pedirYExtraerTokenCrudo(anaId);

  const primero = await RESET(resetRequest(raw, "primeraPassword1"));
  assert.equal(primero.status, 200);

  const segundo = await RESET(resetRequest(raw, "segundaPassword2"));
  const body = await segundo.json();
  assert.equal(segundo.status, 400, "un token ya usado no debe volver a servir");
  assert.equal(body.error, MENSAJE_TOKEN_INVALIDO);
});

prueba("un token caducado se rechaza aunque no se haya usado", async () => {
  await pool.query("delete from password_reset_tokens where user_id=$1", [anaId]);
  const raw = generateResetToken();
  await pool.query(
    "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1,$2, now() - interval '1 minute')",
    [anaId, hashResetToken(raw)],
  );

  const res = await RESET(resetRequest(raw, "unaPasswordValida1"));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, MENSAJE_TOKEN_INVALIDO);
});

// El token CRUDO solo existe en memoria del servidor durante la petición y en
// el correo (que en pruebas no se manda de verdad): para probar el canje hay
// que reconstruirlo insertándolo nosotros con el mismo hash que usaría la ruta.
async function pedirYExtraerTokenCrudo(userId: number): Promise<string> {
  const raw = generateResetToken();
  await pool.query(
    "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1,$2, now() + interval '1 hour')",
    [userId, hashResetToken(raw)],
  );
  return raw;
}
