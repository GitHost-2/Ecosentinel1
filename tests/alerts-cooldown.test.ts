import "./setup-env";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_COOLDOWN_MS,
  FAILURE_COOLDOWN_MS,
  cooldownWindowFor,
  isWithinCooldown,
} from "../lib/alerts";

// Contexto: el 2026-08-17 el cooldown pasó por tres estados en el mismo día
// -- 10 min/2 min (original, evita ráfagas de alertas: un escaneo de
// puertos llegó a producir 91 llamadas a Resend en segundos) -> 0 (a
// petición del usuario, una alerta por cada detección) -> 3 min/1 min
// (mismo usuario, tras ver que 0 mandaba demasiados correos durante un
// ataque sostenido). Ver lib/alerts.ts.

const AHORA = new Date("2026-07-30T18:00:00.000Z");
const haceSegundos = (s: number) => new Date(AHORA.getTime() - s * 1000);

// ── Ventanas ───────────────────────────────────────────────────────────────

test("un envío con éxito calla el canal 3 minutos", () => {
  assert.equal(cooldownWindowFor("sent"), ALERT_COOLDOWN_MS);
  assert.equal(ALERT_COOLDOWN_MS, 3 * 60 * 1000);
});

test("un intento fallido usa una ventana más corta", () => {
  assert.equal(cooldownWindowFor("failed"), FAILURE_COOLDOWN_MS);
  assert.equal(FAILURE_COOLDOWN_MS, 1 * 60 * 1000);
  assert.ok(
    FAILURE_COOLDOWN_MS < ALERT_COOLDOWN_MS,
    "tras un fallo hay que reintentar antes: puede haber sido transitorio",
  );
});

// ── Sin intentos previos ───────────────────────────────────────────────────

test("si nunca se intentó, se envía", () => {
  assert.equal(isWithinCooldown(null, AHORA), false);
});

// ── Tras un envío con éxito ────────────────────────────────────────────────

test("no se reenvía justo después de un envío con éxito", () => {
  const ultimo = { sentAt: haceSegundos(30), status: "sent" };
  assert.equal(isWithinCooldown(ultimo, AHORA), true, "30 s después sigue en cooldown");
});

test("se vuelve a enviar pasados los 3 minutos", () => {
  const ultimo = { sentAt: haceSegundos(181), status: "sent" };
  assert.equal(isWithinCooldown(ultimo, AHORA), false);
});

test("a los 2 minutos todavía calla", () => {
  const ultimo = { sentAt: haceSegundos(120), status: "sent" };
  assert.equal(isWithinCooldown(ultimo, AHORA), true);
});

// ── Tras un fallo ────────────────────────────────────────────────────────

test("un fallo reciente frena el reintento (ventana corta)", () => {
  const ultimo = { sentAt: haceSegundos(5), status: "failed" };
  assert.equal(isWithinCooldown(ultimo, AHORA), true, "5 s tras un fallo NO se reintenta");
});

test("una ráfaga de detecciones tras un fallo solo produce un intento", () => {
  // Simula las 91 detecciones de un escaneo llegando en ~20 s.
  const fallo = { sentAt: haceSegundos(20), status: "failed" };
  let intentos = 0;
  for (let i = 0; i < 91; i++) {
    const momento = new Date(fallo.sentAt.getTime() + i * 200); // una cada 200 ms
    if (!isWithinCooldown(fallo, momento)) intentos++;
  }
  assert.equal(intentos, 0, "ninguna de las 91 detecciones debe reintentar el canal averiado");
});

test("tras el cooldown corto sí se reintenta (por si el fallo fue transitorio)", () => {
  const ultimo = { sentAt: haceSegundos(61), status: "failed" };
  assert.equal(isWithinCooldown(ultimo, AHORA), false, "al minuto se reintenta");
});

test("un fallo NO calla el canal los 3 minutos completos", () => {
  // Un ataque real no debe quedarse sin avisar 3 min por un timeout puntual.
  const ultimo = { sentAt: haceSegundos(90), status: "failed" };
  assert.equal(isWithinCooldown(ultimo, AHORA), false);
});

// ── Compatibilidad con las filas anteriores a la columna ───────────────────

test("un status desconocido se trata como envío con éxito (filas viejas)", () => {
  // Las filas anteriores a la migración 0008 traen 'sent' por defecto, pero se
  // protege el caso de cualquier valor inesperado: ante la duda, callar y no
  // machacar al usuario con alertas.
  const ultimo = { sentAt: haceSegundos(30), status: "cualquier-cosa" };
  assert.equal(isWithinCooldown(ultimo, AHORA), true);
});
