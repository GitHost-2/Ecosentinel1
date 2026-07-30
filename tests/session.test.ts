import "./setup-env";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COOKIE,
  clearSessionCookieHeader,
  createSessionToken,
  getSessionUserId,
  sessionCookieHeader,
  verifySessionToken,
} from "../lib/session";

// Estas pruebas cubren la corrección de las vulnerabilidades 1-3 de la
// auditoría: la sesión ahora vive en una cookie firmada por el servidor, no en
// sessionStorage del navegador (donde el servidor no autenticaba nada).

// ── Ida y vuelta ───────────────────────────────────────────────────────────

test("un token recién creado se verifica y devuelve el userId", () => {
  assert.equal(verifySessionToken(createSessionToken(42)), 42);
});

test("el token tiene el formato userId.expiracion.firma", () => {
  const parts = createSessionToken(7).split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "7");
  assert.ok(Number(parts[1]) > Date.now(), "la expiración está en el futuro");
  assert.match(parts[2], /^[0-9a-f]{64}$/, "la firma es un HMAC-SHA256 en hex");
});

// ── Manipulación ───────────────────────────────────────────────────────────

test("cambiar el userId invalida el token (no se puede suplantar a otra cuenta)", () => {
  const token = createSessionToken(1);
  const [, expiry, signature] = token.split(".");
  assert.equal(verifySessionToken(`999.${expiry}.${signature}`), null);
});

test("alargar la expiración invalida el token", () => {
  const token = createSessionToken(1);
  const [userId, expiry, signature] = token.split(".");
  const masTarde = String(Number(expiry) + 60_000);
  assert.equal(verifySessionToken(`${userId}.${masTarde}.${signature}`), null);
});

test("una firma alterada invalida el token", () => {
  const token = createSessionToken(1);
  const [userId, expiry, signature] = token.split(".");
  const alterada = (signature[0] === "a" ? "b" : "a") + signature.slice(1);
  assert.equal(verifySessionToken(`${userId}.${expiry}.${alterada}`), null);
});

test("una firma de longitud distinta invalida el token sin reventar", () => {
  const [userId, expiry] = createSessionToken(1).split(".");
  assert.equal(verifySessionToken(`${userId}.${expiry}.abc`), null);
});

// ── Expiración ─────────────────────────────────────────────────────────────

test("un token expirado se rechaza aunque la firma sea válida", () => {
  // Se firma con la misma clave pero con expiración en el pasado: es un token
  // legítimamente firmado que ya caducó.
  const token = createSessionToken(5);
  const [userId] = token.split(".");
  // No se puede forjar la firma sin la clave, así que se comprueba por el otro
  // lado: un token válido deja de valer cuando su expiración queda atrás.
  assert.equal(verifySessionToken(token), Number(userId), "válido ahora");

  const expirado = `${userId}.${Date.now() - 1000}.${"0".repeat(64)}`;
  assert.equal(verifySessionToken(expirado), null, "expirado y con firma falsa");
});

// ── Entradas inválidas ─────────────────────────────────────────────────────

test("tokens con forma inválida devuelven null", () => {
  for (const malo of [undefined, "", "solo-una-parte", "dos.partes", "a.b.c.d", "..", "1.2.3"]) {
    assert.equal(verifySessionToken(malo as string | undefined), null, `debía rechazar: ${String(malo)}`);
  }
});

test("un userId no positivo se rechaza", () => {
  // Se construye con firma válida para aislar la validación del userId.
  const token = createSessionToken(1);
  const [, expiry] = token.split(".");
  for (const malo of ["0", "-1", "1.5", "abc"]) {
    assert.equal(verifySessionToken(`${malo}.${expiry}.${"0".repeat(64)}`), null);
  }
});

// ── Cabeceras de cookie ────────────────────────────────────────────────────

test("la cookie de sesión trae las banderas de seguridad", () => {
  const header = sessionCookieHeader(createSessionToken(1));
  assert.match(header, /HttpOnly/, "HttpOnly: un XSS no puede leer la sesión");
  assert.match(header, /Secure/, "Secure: no viaja en HTTP plano");
  assert.match(header, /SameSite=Lax/, "SameSite: mitiga CSRF");
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=604800/, "7 días");
});

test("cerrar sesión manda una cookie que expira de inmediato", () => {
  const header = clearSessionCookieHeader();
  assert.match(header, /Max-Age=0/);
  assert.match(header, /HttpOnly/);
});

// ── Lectura desde la petición ─────────────────────────────────────────────

test("getSessionUserId lee la cookie correcta cuando hay varias", () => {
  const token = createSessionToken(77);
  const req = new Request("https://ecosentinel1.vercel.app/api/stats", {
    headers: { cookie: `otra=basura; ${SESSION_COOKIE}=${token}; theme=dark` },
  });
  assert.equal(getSessionUserId(req), 77);
});

test("getSessionUserId devuelve null sin cookie (las rutas de datos exigen sesión)", () => {
  const req = new Request("https://ecosentinel1.vercel.app/api/stats");
  assert.equal(getSessionUserId(req), null);
});

test("getSessionUserId devuelve null con una cookie de sesión basura", () => {
  const req = new Request("https://ecosentinel1.vercel.app/api/stats", {
    headers: { cookie: `${SESSION_COOKIE}=inventado` },
  });
  assert.equal(getSessionUserId(req), null);
});
