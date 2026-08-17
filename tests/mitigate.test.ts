/**
 * Validación de "Aislar IP" (app/api/mitigate/route.ts).
 *
 * Estas pruebas NO falsean la base: importan el handler REAL y lo corren
 * contra el Postgres LOCAL de pruebas (ver tests/db-local.ts, que solo
 * sustituye el transporte del driver de Neon). Se hace así a propósito,
 * porque casi todo lo que hay que validar aquí es semántica de Postgres que
 * un doble en memoria no reproduce:
 *   - el umbral 0.7 contra una columna `real` (float4, no float8),
 *   - la idempotencia, que descansa en un índice ÚNICO + ON CONFLICT,
 *   - el scoping por dueño, que es un INNER JOIN contra `devices`,
 *   - la integridad con peticiones concurrentes de verdad.
 *
 * Si no hay Postgres local, el archivo se salta entero con el motivo a la
 * vista (no falla), para que `npm test` siga corriendo en otra máquina.
 */
import { pool, closePool, databaseUnavailableReason } from "./db-local";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POST } from "../app/api/mitigate/route";
import { GET as STATS } from "../app/api/stats/route";
import { GET as ALERTS } from "../app/api/alerts/route";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";

const RUTA_MITIGATE = new URL("../app/api/mitigate/route.ts", import.meta.url).pathname;

/** Motivo por el que saltarse las pruebas de base, o false si hay base. */
let sinBase: string | false = "sin inicializar";

// Dos cuentas: ANA es dueña del appliance; BETO es la cuenta ajena que no
// debe poder aislar nada de ANA (vulnerabilidad crítica #1 del README).
let anaId = 0;
let betoId = 0;
let deviceAnaId = 0;
let deviceHuerfanoId = 0; // device sin owner_user_id

before(async () => {
  sinBase = await databaseUnavailableReason();
  if (sinBase) return;

  // Datos aislados por prefijo para no pisar nada más de la base local.
  await pool.query("delete from mitigations");
  await pool.query("delete from detections where src_ip_hash like 'test-aislar-%'");
  await pool.query(
    "delete from device_owners where device_id in (select id from devices where api_key_hash like 'test-aislar-%')",
  );
  await pool.query("delete from devices where api_key_hash like 'test-aislar-%'");
  await pool.query("delete from users where email like 'test-aislar-%'");

  const ana = await pool.query(
    "insert into users (company,email,password_hash) values ('Ana SA','test-aislar-ana@ejemplo.test','x') returning id",
  );
  const beto = await pool.query(
    "insert into users (company,email,password_hash) values ('Beto SA','test-aislar-beto@ejemplo.test','x') returning id",
  );
  anaId = ana.rows[0].id;
  betoId = beto.rows[0].id;

  const dev = await pool.query(
    "insert into devices (nombre_cliente,api_key_hash,owner_user_id) values ('rpi-ana','test-aislar-k1',$1) returning id",
    [anaId],
  );
  const huerfano = await pool.query(
    "insert into devices (nombre_cliente,api_key_hash,owner_user_id) values ('rpi-sin-dueno','test-aislar-k2',null) returning id",
  );
  deviceAnaId = dev.rows[0].id;
  deviceHuerfanoId = huerfano.rows[0].id;

  // Coautoría (ver db/schema.ts, deviceOwners): ANA es coautora de su
  // dispositivo. BETO NO -- es justo lo que valida la vulnerabilidad
  // crítica #1 (que un ajeno no pueda aislar nada de ANA). El huérfano no
  // tiene ninguna fila aquí: nadie debe poder verlo ni operarlo.
  await pool.query("insert into device_owners (device_id,user_id) values ($1,$2)", [deviceAnaId, anaId]);
});

after(async () => { await closePool(); });

/**
 * Declara una prueba que necesita la base local. El motivo del salto se
 * consulta DENTRO del cuerpo: las opciones de `test()` se evalúan al definir
 * el caso, cuando `before()` todavía no ha corrido.
 */
function prueba(nombre: string, cuerpo: () => Promise<void> | void) {
  test(nombre, async (t) => {
    if (sinBase) {
      t.skip(sinBase);
      return;
    }
    await cuerpo();
  });
}

async function nuevaDeteccion(prob: number, deviceId = deviceAnaId, cuando = new Date()) {
  const { rows } = await pool.query(
    `insert into detections (device_id,timestamp,attack_prob,protocol,attack_type,src_ip_hash,dst_port)
     values ($1,$2,$3,'TCP','DDoS','test-aislar-hash',443) returning id`,
    [deviceId, cuando, prob],
  );
  return rows[0].id as number;
}

function peticion(detectionId: unknown, opciones: { userId?: number; cookieCruda?: string; cuerpo?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opciones.cookieCruda !== undefined) headers.cookie = opciones.cookieCruda;
  else if (opciones.userId) headers.cookie = `${SESSION_COOKIE}=${createSessionToken(opciones.userId)}`;
  return new Request("http://localhost/api/mitigate", {
    method: "POST",
    headers,
    body: opciones.cuerpo ?? JSON.stringify({ detectionId }),
  });
}

async function aislar(detectionId: unknown, opciones?: Parameters<typeof peticion>[1]) {
  const res = await POST(peticion(detectionId, opciones));
  return { status: res.status, body: await res.json() };
}

async function filasDe(detectionId: number) {
  const { rows } = await pool.query("select * from mitigations where detection_id=$1", [detectionId]);
  return rows;
}

// ── 1. Autorización: sin sesión no se cambia estado ────────────────────────

prueba("sin cookie de sesión responde 401", async () => {
  const id = await nuevaDeteccion(0.95);
  const { status, body } = await aislar(id);
  assert.equal(status, 401);
  assert.equal(body.error, "No autorizado.");
  assert.equal((await filasDe(id)).length, 0, "un 401 no debe escribir en mitigations");
});

prueba("una cookie con firma inválida responde 401", async () => {
  const id = await nuevaDeteccion(0.95);
  const token = createSessionToken(anaId);
  const manipulado = token.slice(0, -1) + (token.at(-1) === "a" ? "b" : "a");
  const { status } = await aislar(id, { cookieCruda: `${SESSION_COOKIE}=${manipulado}` });
  assert.equal(status, 401, "cambiar un byte de la firma HMAC invalida la sesión");
  assert.equal((await filasDe(id)).length, 0);
});

prueba("una sesión de otro usuario no se puede falsificar cambiando el userId", async () => {
  // El payload va firmado: reescribir el id sin recalcular el HMAC no cuela.
  const id = await nuevaDeteccion(0.95);
  const [, expira, firma] = createSessionToken(betoId).split(".");
  const forjado = `${anaId}.${expira}.${firma}`;
  const { status } = await aislar(id, { cookieCruda: `${SESSION_COOKIE}=${forjado}` });
  assert.equal(status, 401);
  assert.equal((await filasDe(id)).length, 0);
});

// ── 2. Scoping por dueño: la cuenta ajena no puede aislar ──────────────────

prueba("VULN #1: otra cuenta NO puede aislar una detección ajena", async () => {
  const id = await nuevaDeteccion(0.99);
  const { status, body } = await aislar(id, { userId: betoId });
  assert.equal(status, 404, "Beto no es dueño del device de Ana");
  assert.equal(body.ok, undefined);
  assert.equal((await filasDe(id)).length, 0, "no debe quedar rastro de la mitigación ajena");

  // Y la dueña sí puede: confirma que el 404 fue por scoping, no por otra cosa.
  const propia = await aislar(id, { userId: anaId });
  assert.equal(propia.status, 200);
  assert.equal((await filasDe(id)).length, 1);
});

prueba("un device sin dueño no es aislable por ninguna cuenta", async () => {
  const id = await nuevaDeteccion(0.99, deviceHuerfanoId);
  for (const userId of [anaId, betoId]) {
    const { status } = await aislar(id, { userId });
    assert.equal(status, 404, "owner_user_id NULL no debe emparejar con ningún usuario");
  }
  assert.equal((await filasDe(id)).length, 0);
});

// ── 3. Enumeración de ids: las respuestas no distinguen casos ──────────────

prueba("id inexistente e id ajeno dan exactamente la misma respuesta", async () => {
  const ajena = await nuevaDeteccion(0.99);
  const respuestaAjena = await aislar(ajena, { userId: betoId });
  const respuestaInexistente = await aislar(2_000_000_000, { userId: betoId });

  assert.equal(respuestaAjena.status, respuestaInexistente.status, "mismo código");
  assert.deepEqual(respuestaAjena.body, respuestaInexistente.body, "mismo cuerpo");
  assert.equal(respuestaAjena.status, 404);
});

prueba("el 404 no filtra datos de la detección ajena", async () => {
  const id = await nuevaDeteccion(0.99);
  const { body } = await aislar(id, { userId: betoId });
  const texto = JSON.stringify(body);
  for (const filtrado of ["test-aislar-hash", "DDoS", "443", "0.99", String(deviceAnaId)]) {
    assert.ok(!texto.includes(filtrado), `el error no debe revelar "${filtrado}"`);
  }
  assert.equal(Object.keys(body).length, 1, "solo el campo error");
});

// ── 4. Validación de entrada ───────────────────────────────────────────────

prueba("detectionId inválido responde 400 sin tocar la base", async () => {
  const invalidos: unknown[] = [0, -1, 1.5, "abc", "", null, undefined, NaN, {}, []];
  for (const valor of invalidos) {
    const { status, body } = await aislar(valor, { userId: anaId });
    assert.equal(status, 400, `detectionId=${JSON.stringify(valor)} debe ser 400`);
    assert.equal(body.error, "detectionId inválido.");
  }
  const { rows } = await pool.query("select count(*)::int as n from mitigations");
  assert.ok(rows[0].n >= 0, "ninguna entrada inválida debe haber escrito");
});

prueba("los tipos que JS convierte a un entero se aceptan como ese entero", async () => {
  // Comportamiento observado, no un hueco: la ruta usa `Number(...)`, así que
  // `true`, `"7"` y `["7"]` se convierten a 1, 7 y 7. NO es explotable porque
  // el id resultante sigue pasando por el filtro de dueño (INNER JOIN contra
  // `devices`), que es lo que de verdad protege. Se fija por escrito para que
  // se note si alguien cambia la validación.
  const id = await nuevaDeteccion(0.95);
  for (const equivalente of [id, String(id), [String(id)]] as unknown[]) {
    const { status } = await aislar(equivalente, { userId: anaId });
    assert.equal(status, 200, `${JSON.stringify(equivalente)} se trata como el id ${id}`);
  }
  assert.equal((await filasDe(id)).length, 1);

  // Y esa laxitud NO salta el scoping: la misma coerción con otra cuenta falla.
  const { status } = await aislar(String(id), { userId: betoId });
  assert.equal(status, 404);
});

prueba("un cuerpo que no es JSON responde 400, no 500", async () => {
  const { status } = await aislar(null, { userId: anaId, cuerpo: "esto no es json{" });
  assert.equal(status, 400);
});

prueba("REGRESIÓN: un detectionId fuera del rango de int4 da 400, no 500", async () => {
  // Antes solo se validaba `> 0`. Como `detections.id` es `serial` (int4),
  // Postgres abortaba con "value out of range for type integer" y la ruta
  // reventaba con 500: cualquier cuenta autenticada podía provocarlo, y el
  // 500 se distinguía del 404 (señal útil para quien enumera ids).
  for (const id of [2_147_483_648, 9_007_199_254_740_991, 1e30]) {
    const { status, body } = await aislar(id, { userId: anaId });
    assert.equal(status, 400, `detectionId=${id} debe rechazarse antes de llegar a SQL`);
    assert.equal(body.error, "detectionId inválido.");
  }
});

prueba("el id máximo de int4 sigue siendo válido (404, no 400)", async () => {
  const { status } = await aislar(2_147_483_647, { userId: anaId });
  assert.equal(status, 404, "2147483647 sí cabe en int4: es 'no encontrada', no 'inválido'");
});

// ── 5. Umbral BLOCK_THRESHOLD en los bordes ────────────────────────────────

prueba("0.699 se rechaza: no alcanza la confianza mínima", async () => {
  const id = await nuevaDeteccion(0.699);
  const { status, body } = await aislar(id, { userId: anaId });
  assert.equal(status, 400);
  assert.match(body.error, /confianza mínima/);
  assert.equal((await filasDe(id)).length, 0, "una detección de baja confianza no debe registrarse");
});

prueba("0.700 exacto se ACEPTA (el umbral es >=, no >)", async () => {
  // Ojo: `attack_prob` es `real` (float4), que no representa 0.7 exacto. Lo
  // que salva el borde es que Postgres imprime ese float4 como "0.7" (texto
  // de ida y vuelta más corto) y el driver lo parsea a 0.7 exacto en JS. Se
  // comprueba explícitamente para que un cambio de tipo o de driver no
  // desplace el umbral en silencio.
  const id = await nuevaDeteccion(0.7);
  const { rows } = await pool.query("select attack_prob::text as t from detections where id=$1", [id]);
  assert.equal(rows[0].t, "0.7", "float4 debe volver como '0.7'");
  assert.equal(parseFloat(rows[0].t), 0.7);

  const { status, body } = await aislar(id, { userId: anaId });
  assert.equal(status, 200, "0.700 cumple el umbral documentado (>= 0.7)");
  assert.equal(body.ok, true);
  assert.equal((await filasDe(id)).length, 1);
});

prueba("0.701 se acepta", async () => {
  const id = await nuevaDeteccion(0.701);
  const { status } = await aislar(id, { userId: anaId });
  assert.equal(status, 200);
  assert.equal((await filasDe(id)).length, 1);
});

prueba("el umbral coincide con lo que /api/stats cuenta como bloqueado", async () => {
  // El comentario de la ruta promete "misma alta confianza que /api/stats".
  // stats compara en SQL (float4) y mitigate en JS (float64): si divergieran,
  // el panel contaría como "bloqueado" algo que el botón rechaza.
  await pool.query("delete from detections where src_ip_hash like 'test-aislar-%'");
  const probs = [0.5, 0.699, 0.7, 0.701, 0.99];
  const ids: Record<number, number> = {};
  for (const p of probs) ids[p] = await nuevaDeteccion(p);

  const cookie = `${SESSION_COOKIE}=${createSessionToken(anaId)}`;
  const stats = await (await STATS(new Request("http://localhost/api/stats", { headers: { cookie } }))).json();

  let aceptadas = 0;
  for (const p of probs) {
    const { status } = await aislar(ids[p], { userId: anaId });
    if (status === 200) aceptadas++;
  }
  assert.equal(stats.detected, probs.length);
  assert.equal(
    stats.blocked, aceptadas,
    `stats dice ${stats.blocked} bloqueadas pero mitigate aceptó ${aceptadas}: los umbrales divergen`,
  );
  assert.equal(aceptadas, 3, "0.7, 0.701 y 0.99");
});

prueba("/api/alerts marca aislable exactamente lo que mitigate acepta", async () => {
  // El botón "Aislar IP" solo se dibuja si alerts devuelve blocked=true
  // (public/js/dashboard.js). Si alerts y mitigate no coincidieran, habría
  // botones que siempre fallan, o detecciones aislables sin botón.
  await pool.query("delete from detections where src_ip_hash like 'test-aislar-%'");
  const probs = [0.5, 0.699, 0.7, 0.701];
  for (const p of probs) await nuevaDeteccion(p);

  const cookie = `${SESSION_COOKIE}=${createSessionToken(anaId)}`;
  const alertas = await (await ALERTS(new Request("http://localhost/api/alerts", { headers: { cookie } }))).json();

  for (const alerta of alertas) {
    const { status } = await aislar(alerta.id, { userId: anaId });
    assert.equal(
      alerta.blocked, status === 200,
      `prob=${alerta.prob}: alerts dice blocked=${alerta.blocked} pero mitigate respondió ${status}`,
    );
  }
});

// ── 6. Idempotencia / doble aislamiento ────────────────────────────────────

prueba("aislar dos veces no duplica ni corrompe la fila", async () => {
  const id = await nuevaDeteccion(0.95);
  const primera = await aislar(id, { userId: anaId });
  const filaInicial = (await filasDe(id))[0];

  await new Promise((r) => setTimeout(r, 30));
  const segunda = await aislar(id, { userId: anaId });
  const filas = await filasDe(id);

  assert.equal(primera.status, 200);
  assert.equal(segunda.status, 200, "el segundo intento no es un error para quien lo pulsa");
  assert.equal(filas.length, 1, "una sola fila por detección (índice único)");
  assert.equal(filas[0].id, filaInicial.id, "es la MISMA fila, no una nueva");
  assert.equal(
    filas[0].created_at.getTime(), filaInicial.created_at.getTime(),
    "ON CONFLICT DO NOTHING: no se pisa la marca de tiempo de la confirmación original",
  );
});

prueba("la guía se devuelve igual en el segundo intento", async () => {
  const id = await nuevaDeteccion(0.95);
  const a = await aislar(id, { userId: anaId });
  const b = await aislar(id, { userId: anaId });
  assert.deepEqual(a.body, b.body, "el usuario no se queda sin instrucciones al reintentar");
});

// ── 7. Persistencia ────────────────────────────────────────────────────────

prueba("la fila de mitigations queda con detección, device y hora correctas", async () => {
  const antes = Date.now();
  const id = await nuevaDeteccion(0.88);
  const { status } = await aislar(id, { userId: anaId });
  assert.equal(status, 200);

  const filas = await filasDe(id);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].detection_id, id);
  assert.equal(filas[0].device_id, deviceAnaId, "el device se copia de la detección, no del cliente");
  const t = filas[0].created_at.getTime();
  assert.ok(t >= antes - 1000 && t <= Date.now() + 1000, "created_at es del momento de la confirmación");
});

prueba("la mitigación se refleja en /api/alerts como mitigated", async () => {
  await pool.query("delete from detections where src_ip_hash like 'test-aislar-%'");
  const id = await nuevaDeteccion(0.93);
  const cookie = `${SESSION_COOKIE}=${createSessionToken(anaId)}`;

  const antes = await (await ALERTS(new Request("http://localhost/api/alerts", { headers: { cookie } }))).json();
  assert.equal(antes.find((a: { id: number }) => a.id === id).mitigated, false);

  await aislar(id, { userId: anaId });

  const despues = await (await ALERTS(new Request("http://localhost/api/alerts", { headers: { cookie } }))).json();
  assert.equal(despues.find((a: { id: number }) => a.id === id).mitigated, true);
});

prueba("la ventana de la guía es de ±10 s alrededor del timestamp de la detección", async () => {
  const cuando = new Date("2026-07-30T18:00:00.000Z");
  const id = await nuevaDeteccion(0.95, deviceAnaId, cuando);
  const { body } = await aislar(id, { userId: anaId });

  assert.ok(body.guidance.findRealIpCommand.includes("2026-07-30T17:59:50.000Z"), "--since = t-10s");
  assert.ok(body.guidance.findRealIpCommand.includes("2026-07-30T18:00:10.000Z"), "--until = t+10s");
  assert.equal(body.guidance.steps.length, 3);
});

prueba("la respuesta NO devuelve la IP real ni el hash de origen", async () => {
  // Regla no negociable del proyecto: la IP en claro nunca sale de la RPi, y
  // aquí ni siquiera se reexpone el hash guardado.
  const id = await nuevaDeteccion(0.95);
  const { body } = await aislar(id, { userId: anaId });
  const texto = JSON.stringify(body);
  assert.ok(!texto.includes("test-aislar-hash"), "no se devuelve el src_ip_hash");
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(texto.replace(/192\.168\.[01]\.1/g, "")),
    "la única IP admisible en el texto es la del panel del router");
});

// ── 8. Integridad con concurrencia ─────────────────────────────────────────

prueba("12 peticiones simultáneas dejan exactamente una fila", async () => {
  const id = await nuevaDeteccion(0.97);
  const respuestas = await Promise.all(
    Array.from({ length: 12 }, () => aislar(id, { userId: anaId })),
  );
  assert.ok(respuestas.every((r) => r.status === 200), "ninguna carrera debe reventar con 500");
  const filas = await filasDe(id);
  assert.equal(filas.length, 1, "el índice único + ON CONFLICT resuelve la carrera");
});

prueba("peticiones concurrentes de la dueña y de un tercero: solo cuenta la dueña", async () => {
  const id = await nuevaDeteccion(0.97);
  const respuestas = await Promise.all([
    aislar(id, { userId: betoId }), aislar(id, { userId: anaId }),
    aislar(id, { userId: betoId }), aislar(id, { userId: anaId }),
  ]);
  assert.deepEqual(respuestas.map((r) => r.status), [404, 200, 404, 200]);
  assert.equal((await filasDe(id)).length, 1);
});

prueba("aislar detecciones distintas en paralelo escribe una fila por cada una", async () => {
  const ids = await Promise.all([0.8, 0.85, 0.9, 0.95].map((p) => nuevaDeteccion(p)));
  const respuestas = await Promise.all(ids.map((id) => aislar(id, { userId: anaId })));
  assert.ok(respuestas.every((r) => r.status === 200));
  for (const id of ids) assert.equal((await filasDe(id)).length, 1);
});

// ── 9. Confirmación humana: la ruta NO actúa sobre la red (README §7) ──────
//
// Estas pruebas leen el código fuente. Es deliberado: lo que hay que
// demostrar es una AUSENCIA (que no existe ninguna vía para tocar la red),
// y eso no se prueba ejecutando, se prueba inspeccionando. No dependen de la
// base, así que corren siempre.

test("la ruta no importa nada capaz de tocar la red ni de ejecutar comandos", () => {
  const fuente = readFileSync(RUTA_MITIGATE, "utf8");
  const imports = [...fuente.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  const permitidos = ["next/server", "drizzle-orm", "@/db", "@/db/schema", "@/lib/session"];
  assert.deepEqual(imports, permitidos, "cualquier import nuevo aquí hay que revisarlo a mano");

  for (const peligroso of ["child_process", "node:child_process", "node:net", "node:dgram", "ssh2", "node:dns"]) {
    assert.ok(!imports.includes(peligroso), `no debe importar ${peligroso}`);
  }
});

test("no hay ejecución de comandos, ni ARP spoofing, ni llamadas al router", () => {
  const fuente = readFileSync(RUTA_MITIGATE, "utf8");
  // Se mira solo el CÓDIGO: los comentarios y la guía al usuario sí nombran
  // el router y journalctl a propósito, y no deben disparar la prueba.
  const codigo = fuente
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

  for (const patron of [
    /\bexec\b/, /\bexecSync\b/, /\bspawn\b/, /\bfetch\s*\(/, /\barpspoof\b/,
    /\biptables\b/, /\bnftables\b/, /\bssh\b/, /\bnetsh\b/, /\bip\s+route\b/,
  ]) {
    assert.ok(!patron.test(codigo), `el código no debe contener ${patron}`);
  }

  // Lo único que escribe es la fila de confirmación humana.
  const escrituras = [...codigo.matchAll(/db\s*\.\s*(insert|update|delete)/g)].map((m) => m[1]);
  assert.deepEqual(escrituras, ["insert"], "solo un INSERT: la confirmación en `mitigations`");
  assert.ok(/mitigations/.test(codigo), "y va a la tabla mitigations");
});

prueba("la respuesta de éxito es solo guía textual para un humano", async () => {
  const id = await nuevaDeteccion(0.95);
  const { body } = await aislar(id, { userId: anaId });

  // Contrato explícito: `ok` + `guidance`, nada que parezca una acción de red
  // ejecutada (sin campos tipo "blocked", "firewallRule", "applied"...).
  assert.deepEqual(Object.keys(body).sort(), ["guidance", "ok"]);
  assert.deepEqual(Object.keys(body.guidance).sort(), ["findRealIpCommand", "steps"]);
  assert.ok(body.guidance.steps.every((s: unknown) => typeof s === "string"));
  // La guía manda al humano al router: es la decisión de diseño del README §7.
  assert.match(JSON.stringify(body.guidance.steps), /router/i);
});
