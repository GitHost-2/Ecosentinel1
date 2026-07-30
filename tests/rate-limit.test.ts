import "./setup-env";
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  checkRateLimit,
  checkRateLimitSafe,
  clientIp,
  memoryStore,
  shouldPurge,
  tooManyRequests,
  windowStartFor,
  type RateLimitStore,
} from "../lib/rate-limit";

// ── Alineación de la ventana fija ───────────────────────────────────────────

test("windowStartFor alinea al inicio de la ventana", () => {
  const now = new Date("2026-07-30T08:47:35.000Z");
  assert.equal(windowStartFor(now, 60).toISOString(), "2026-07-30T08:47:00.000Z");
  assert.equal(windowStartFor(now, 900).toISOString(), "2026-07-30T08:45:00.000Z");
});

test("dos instantes de la misma ventana comparten inicio", () => {
  const a = new Date("2026-07-30T08:47:00.000Z");
  const b = new Date("2026-07-30T08:47:59.999Z");
  assert.equal(windowStartFor(a, 60).getTime(), windowStartFor(b, 60).getTime());
});

// ── Decisión de permitir / bloquear ─────────────────────────────────────────

test("permite exactamente hasta el límite y bloquea el siguiente", async () => {
  const store = memoryStore();
  const now = new Date("2026-07-30T08:47:00.000Z");
  const opts = { key: "login:ip:1.2.3.4", limit: 3, windowSeconds: 60, store, now };

  const r1 = await checkRateLimit(opts);
  const r2 = await checkRateLimit(opts);
  const r3 = await checkRateLimit(opts);
  const r4 = await checkRateLimit(opts);

  assert.equal(r1.allowed, true, "1er intento permitido");
  assert.equal(r2.allowed, true, "2do intento permitido");
  assert.equal(r3.allowed, true, "3er intento permitido (justo en el límite)");
  assert.equal(r4.allowed, false, "4to intento bloqueado");
});

test("remaining baja hasta 0 y no se vuelve negativo", async () => {
  const store = memoryStore();
  const now = new Date("2026-07-30T08:47:00.000Z");
  const opts = { key: "k", limit: 2, windowSeconds: 60, store, now };

  assert.equal((await checkRateLimit(opts)).remaining, 1);
  assert.equal((await checkRateLimit(opts)).remaining, 0);
  assert.equal((await checkRateLimit(opts)).remaining, 0, "no baja de 0");
});

test("una ventana nueva reinicia el contador", async () => {
  const store = memoryStore();
  const base = { key: "k", limit: 1, windowSeconds: 60, store };

  const primera = await checkRateLimit({ ...base, now: new Date("2026-07-30T08:47:10.000Z") });
  const bloqueada = await checkRateLimit({ ...base, now: new Date("2026-07-30T08:47:50.000Z") });
  const siguiente = await checkRateLimit({ ...base, now: new Date("2026-07-30T08:48:01.000Z") });

  assert.equal(primera.allowed, true);
  assert.equal(bloqueada.allowed, false, "misma ventana: bloqueada");
  assert.equal(siguiente.allowed, true, "ventana siguiente: permitida otra vez");
});

test("claves distintas no comparten cupo", async () => {
  const store = memoryStore();
  const now = new Date("2026-07-30T08:47:00.000Z");

  await checkRateLimit({ key: "login:ip:1.1.1.1", limit: 1, windowSeconds: 60, store, now });
  const otra = await checkRateLimit({ key: "login:ip:2.2.2.2", limit: 1, windowSeconds: 60, store, now });

  assert.equal(otra.allowed, true, "una IP no consume el cupo de otra");
});

test("retryAfterSeconds apunta al final de la ventana", async () => {
  const store = memoryStore();
  // 08:47:20 en una ventana de 60 s -> quedan 40 s.
  const r = await checkRateLimit({
    key: "k",
    limit: 1,
    windowSeconds: 60,
    store,
    now: new Date("2026-07-30T08:47:20.000Z"),
  });
  assert.equal(r.retryAfterSeconds, 40);
});

test("retryAfterSeconds nunca es 0 (Retry-After: 0 invitaría a reintentar de inmediato)", async () => {
  const store = memoryStore();
  const r = await checkRateLimit({
    key: "k",
    limit: 1,
    windowSeconds: 60,
    store,
    now: new Date("2026-07-30T08:47:59.999Z"),
  });
  assert.ok(r.retryAfterSeconds >= 1, `esperaba >=1, fue ${r.retryAfterSeconds}`);
});

// ── Fail-open ante caída de la base ────────────────────────────────────────

test("checkRateLimitSafe permite la petición si el store falla (fail-open)", async () => {
  const roto: RateLimitStore = {
    async increment() {
      throw new Error("Neon no responde");
    },
  };
  const r = await checkRateLimitSafe({ key: "k", limit: 5, windowSeconds: 60, store: roto });

  assert.equal(r.allowed, true, "una caída de la base no debe tirar el login ni la ingesta");
  assert.equal(r.retryAfterSeconds, 0);
});

test("checkRateLimit SÍ propaga el error (el fail-open es decisión de quien llama)", async () => {
  const roto: RateLimitStore = {
    async increment() {
      throw new Error("Neon no responde");
    },
  };
  await assert.rejects(
    () => checkRateLimit({ key: "k", limit: 5, windowSeconds: 60, store: roto }),
    /Neon no responde/,
  );
});

// ── Extracción de la IP del cliente (anti-spoofing) ────────────────────────

test("clientIp toma el ÚLTIMO valor de x-forwarded-for, no el primero", () => {
  // El proxy apende la IP real al final. Tomar el primero permitiría saltarse
  // el límite mandando un x-forwarded-for inventado.
  const req = new Request("https://ecosentinel1.vercel.app/api/auth/login", {
    headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
  });
  assert.equal(clientIp(req), "203.0.113.7");
});

test("clientIp prefiere x-real-ip cuando está presente", () => {
  const req = new Request("https://ecosentinel1.vercel.app/api/auth/login", {
    headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "9.9.9.9" },
  });
  assert.equal(clientIp(req), "203.0.113.7");
});

test("clientIp devuelve 'desconocida' sin cabeceras de proxy", () => {
  const req = new Request("https://ecosentinel1.vercel.app/api/auth/login");
  assert.equal(clientIp(req), "desconocida");
});

test("una IP falseada no comparte cubo con la IP real", async () => {
  const store = memoryStore();
  const now = new Date("2026-07-30T08:47:00.000Z");
  const real = clientIp(
    new Request("https://x.test", { headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" } }),
  );
  const falseada = clientIp(
    new Request("https://x.test", { headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.7" } }),
  );
  assert.equal(real, falseada, "ambas resuelven a la IP que puso el proxy");

  await checkRateLimit({ key: `login:ip:${real}`, limit: 1, windowSeconds: 60, store, now });
  const segunda = await checkRateLimit({
    key: `login:ip:${falseada}`,
    limit: 1,
    windowSeconds: 60,
    store,
    now,
  });
  assert.equal(segunda.allowed, false, "cambiar el x-forwarded-for no consigue cupo nuevo");
});

// ── Respuesta 429 ──────────────────────────────────────────────────────────

test("tooManyRequests devuelve 429 con Retry-After", async () => {
  const res = tooManyRequests("Demasiados intentos.", 42);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "42");
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await res.json(), { error: "Demasiados intentos." });
});

// ── Límites configurados ───────────────────────────────────────────────────

test("el límite de ingesta aguanta la ráfaga de un port scan real", () => {
  // Medido el 2026-07-30: un `nmap -sS -p 1-500` produjo 499 detecciones en
  // menos de 2 s. Si el límite fuera menor, se perdería evidencia de un ataque.
  assert.ok(
    LIMITS.ingestPerDevice.limit >= 499,
    `el límite por dispositivo (${LIMITS.ingestPerDevice.limit}) tiraría detecciones de un nmap de 500 puertos`,
  );
});

test("el login es más estricto que la ingesta", () => {
  assert.ok(LIMITS.loginPerIp.limit < LIMITS.ingestPerDevice.limit);
  assert.ok(LIMITS.loginPerIp.limit <= LIMITS.loginPerEmail.limit, "por IP nunca más laxo que por correo");
});

test("shouldPurge respeta la probabilidad en los extremos", () => {
  assert.equal(shouldPurge(0), false, "probabilidad 0 nunca purga");
  assert.equal(shouldPurge(1), true, "probabilidad 1 siempre purga");
});
