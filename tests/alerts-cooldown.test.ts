import "./setup-env";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_COOLDOWN_MS,
  FAILURE_COOLDOWN_MS,
  cooldownWindowFor,
  isWithinCooldown,
} from "../lib/alerts";

// Contexto histórico: hasta el 2026-08-17 había cooldown (10 min tras un
// envío OK, 2 min tras un fallo) para evitar ráfagas de alertas -- un
// escaneo de puertos llegó a producir 91 llamadas a Resend en segundos. El
// usuario pidió explícitamente quitarlo del todo: quiere una alerta por
// CADA detección, sin excepción, aceptando ese riesgo. Ver lib/alerts.ts.

const AHORA = new Date("2026-07-30T18:00:00.000Z");
const haceSegundos = (s: number) => new Date(AHORA.getTime() - s * 1000);

test("no hay ventana de espera: ni tras un envío OK ni tras un fallo", () => {
  assert.equal(ALERT_COOLDOWN_MS, 0);
  assert.equal(FAILURE_COOLDOWN_MS, 0);
  assert.equal(cooldownWindowFor("sent"), 0);
  assert.equal(cooldownWindowFor("failed"), 0);
});

test("si nunca se intentó, se envía", () => {
  assert.equal(isWithinCooldown(null, AHORA), false);
});

test("un envío OK hace un instante NO frena el siguiente (sin cooldown)", () => {
  const ultimo = { sentAt: haceSegundos(0), status: "sent" };
  assert.equal(isWithinCooldown(ultimo, AHORA), false);
});

test("un fallo hace un instante NO frena el reintento (sin cooldown)", () => {
  const ultimo = { sentAt: haceSegundos(0), status: "failed" };
  assert.equal(isWithinCooldown(ultimo, AHORA), false);
});

test("una ráfaga de 91 detecciones produce 91 intentos, ninguno frenado", () => {
  // El escenario que antes motivaba el cooldown: ahora, a propósito, cada
  // detección de la ráfaga debe intentar el envío.
  let intentos = 0;
  let ultimo: { sentAt: Date; status: string } | null = null;
  for (let i = 0; i < 91; i++) {
    const momento = new Date(AHORA.getTime() + i * 200); // una cada 200 ms
    if (!isWithinCooldown(ultimo, momento)) {
      intentos++;
      ultimo = { sentAt: momento, status: "sent" };
    }
  }
  assert.equal(intentos, 91, "sin cooldown, cada detección de la ráfaga debe intentar el envío");
});
