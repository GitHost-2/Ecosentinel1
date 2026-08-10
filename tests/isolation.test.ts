/**
 * Aislamiento REAL de una IP (corte por ARP spoofing en la RPi).
 *
 * app/api/mitigate/isolate y .../lift los llama el PANEL (sesión de usuario,
 * scoping por dueño -- mismo patrón que tests/mitigate.test.ts).
 * app/api/mitigate/pending y .../ack los llama la RPi (API key de
 * dispositivo, mismo patrón que la ingesta). Lo crítico a probar es que
 * ninguno de los dos lados pueda leer o mover lo que no es suyo: un usuario
 * no puede aislar la IP de otro dueño, y un dispositivo no puede ver ni
 * confirmar las órdenes de otro dispositivo.
 *
 * Contra Postgres LOCAL real (ver tests/db-local.ts); se salta si no hay base.
 */
import { pool, closePool, databaseUnavailableReason } from "./db-local";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { POST as ISOLATE } from "../app/api/mitigate/isolate/route";
import { POST as LIFT } from "../app/api/mitigate/lift/route";
import { GET as PENDING } from "../app/api/mitigate/pending/route";
import { POST as ACK } from "../app/api/mitigate/ack/route";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";
import { generateApiKey } from "../lib/device-auth";

let sinBase: string | false = "sin inicializar";

let anaId = 0;
let betoId = 0;
let deviceAnaId = 0;
let deviceBetoId = 0;
let apiKeyAna = "";
let apiKeyBeto = "";

before(async () => {
  sinBase = await databaseUnavailableReason();
  if (sinBase) return;

  await pool.query("delete from isolation_orders");
  await pool.query("delete from detections where src_ip_hash like 'test-iso-%'");
  await pool.query("delete from devices where api_key_hash like 'test-iso-%'");
  await pool.query("delete from users where email like 'test-iso-%'");

  const ana = await pool.query(
    "insert into users (company,email,password_hash) values ('Ana Iso','test-iso-ana@ejemplo.test','x') returning id",
  );
  const beto = await pool.query(
    "insert into users (company,email,password_hash) values ('Beto Iso','test-iso-beto@ejemplo.test','x') returning id",
  );
  anaId = ana.rows[0].id;
  betoId = beto.rows[0].id;

  const keyAna = generateApiKey();
  const keyBeto = generateApiKey();
  apiKeyAna = keyAna.raw;
  apiKeyBeto = keyBeto.raw;

  const devAna = await pool.query(
    "insert into devices (nombre_cliente,api_key_hash,owner_user_id) values ('rpi-ana-iso',$1,$2) returning id",
    [keyAna.hash, anaId],
  );
  const devBeto = await pool.query(
    "insert into devices (nombre_cliente,api_key_hash,owner_user_id) values ('rpi-beto-iso',$1,$2) returning id",
    [keyBeto.hash, betoId],
  );
  deviceAnaId = devAna.rows[0].id;
  deviceBetoId = devBeto.rows[0].id;
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

async function nuevaDeteccion(prob: number, deviceId = deviceAnaId, hash = `test-iso-hash-${Date.now()}-${Math.random()}`) {
  const { rows } = await pool.query(
    `insert into detections (device_id,timestamp,attack_prob,protocol,attack_type,src_ip_hash,dst_port)
     values ($1,now(),$2,'TCP','Port Scanning',$3,443) returning id, src_ip_hash`,
    [deviceId, prob, hash],
  );
  return { id: rows[0].id as number, hash: rows[0].src_ip_hash as string };
}

function peticionSesion(url: string, body: unknown, opciones: { userId?: number; cookieCruda?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opciones.cookieCruda !== undefined) headers.cookie = opciones.cookieCruda;
  else if (opciones.userId) headers.cookie = `${SESSION_COOKIE}=${createSessionToken(opciones.userId)}`;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function peticionDispositivo(url: string, apiKey: string | null, opciones: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return new Request(url, {
    method: opciones.method ?? "GET",
    headers,
    body: opciones.body !== undefined ? JSON.stringify(opciones.body) : undefined,
  });
}

async function ordenDe(deviceId: number, hash: string) {
  const { rows } = await pool.query(
    "select * from isolation_orders where device_id=$1 and src_ip_hash=$2",
    [deviceId, hash],
  );
  return rows[0] ?? null;
}

// ── POST /api/mitigate/isolate ──────────────────────────────────────────────

prueba("isolate sin sesión responde 401 y no crea orden", async () => {
  const { id, hash } = await nuevaDeteccion(0.95);
  const res = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }));
  assert.equal(res.status, 401);
  assert.equal(await ordenDe(deviceAnaId, hash), null);
});

prueba("VULN pattern: otra cuenta no puede pedir aislar una detección ajena", async () => {
  const { id, hash } = await nuevaDeteccion(0.95);
  const res = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: betoId }));
  assert.equal(res.status, 404, "Beto no es dueño del device de Ana");
  assert.equal(await ordenDe(deviceAnaId, hash), null, "no debe quedar rastro de la orden ajena");
});

prueba("isolate exige la misma confianza mínima que la guía manual (0.7)", async () => {
  const { id, hash } = await nuevaDeteccion(0.5);
  const res = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  assert.equal(res.status, 400);
  assert.equal(await ordenDe(deviceAnaId, hash), null);
});

prueba("isolate con confianza alta crea una orden pendiente con desired=isolated", async () => {
  const { id, hash } = await nuevaDeteccion(0.95);
  const res = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "pending");

  const orden = await ordenDe(deviceAnaId, hash);
  assert.ok(orden);
  assert.equal(orden.desired, "isolated");
  assert.equal(orden.applied, "pending");
  assert.equal(orden.requested_by_user_id, anaId);
});

prueba("dos solicitudes del mismo hash no duplican la orden (upsert)", async () => {
  const hash = `test-iso-hash-dup-${Date.now()}`;
  const d1 = await nuevaDeteccion(0.9, deviceAnaId, hash);
  const d2 = await nuevaDeteccion(0.92, deviceAnaId, hash);

  await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: d1.id }, { userId: anaId }));
  await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: d2.id }, { userId: anaId }));

  const { rows } = await pool.query(
    "select count(*)::int as n from isolation_orders where device_id=$1 and src_ip_hash=$2",
    [deviceAnaId, hash],
  );
  assert.equal(rows[0].n, 1, "el índice único (device_id, src_ip_hash) debe evitar la segunda fila");

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.detection_id, d2.id, "la orden reabierta apunta a la detección más reciente");
});

// ── POST /api/mitigate/lift ─────────────────────────────────────────────────

prueba("lift sin orden previa responde 404", async () => {
  const { id } = await nuevaDeteccion(0.95);
  const res = await LIFT(peticionSesion("http://localhost/api/mitigate/lift", { detectionId: id }, { userId: anaId }));
  assert.equal(res.status, 404);
});

prueba("lift sobre una orden aislada la marca desired=released, applied=pending", async () => {
  const { id, hash } = await nuevaDeteccion(0.95);
  await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  // Simula que la RPi ya confirmó el corte (lo probaría ack más abajo).
  await pool.query("update isolation_orders set applied='isolated' where device_id=$1 and src_ip_hash=$2", [deviceAnaId, hash]);

  const res = await LIFT(peticionSesion("http://localhost/api/mitigate/lift", { detectionId: id }, { userId: anaId }));
  assert.equal(res.status, 200);

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.desired, "released");
  assert.equal(orden.applied, "pending");
});

prueba("otra cuenta no puede pedir lift sobre una detección ajena", async () => {
  const { id, hash } = await nuevaDeteccion(0.95);
  await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  await pool.query("update isolation_orders set applied='isolated' where device_id=$1 and src_ip_hash=$2", [deviceAnaId, hash]);

  const res = await LIFT(peticionSesion("http://localhost/api/mitigate/lift", { detectionId: id }, { userId: betoId }));
  assert.equal(res.status, 404);

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.desired, "isolated", "la orden de Ana no debe moverse por la petición de Beto");
});

// ── GET /api/mitigate/pending (la RPi) ──────────────────────────────────────

prueba("pending sin Authorization responde 401", async () => {
  const res = await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", null));
  assert.equal(res.status, 401);
});

prueba("pending con una api key inválida responde 401", async () => {
  const res = await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", "esto-no-es-una-key-valida"));
  assert.equal(res.status, 401);
});

prueba("pending solo devuelve lo pendiente del dispositivo autenticado", async () => {
  const { id, hash } = await nuevaDeteccion(0.95, deviceAnaId, `test-iso-pending-${Date.now()}`);
  await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));

  const resAna = await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", apiKeyAna));
  const listaAna = await resAna.json();
  assert.equal(resAna.status, 200);
  assert.ok(listaAna.some((o: { srcIpHash: string }) => o.srcIpHash === hash), "el dispositivo de Ana debe ver su propia orden");
  assert.ok("orderId" in listaAna[0], "cada entrada trae orderId");

  const resBeto = await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", apiKeyBeto));
  const listaBeto = await resBeto.json();
  assert.equal(
    listaBeto.some((o: { srcIpHash: string }) => o.srcIpHash === hash),
    false,
    "VULN pattern: el dispositivo de Beto NO debe ver la orden del de Ana",
  );
});

prueba("pending no devuelve órdenes ya resueltas", async () => {
  const { id, hash } = await nuevaDeteccion(0.95, deviceAnaId, `test-iso-resuelta-${Date.now()}`);
  await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  await pool.query("update isolation_orders set applied='isolated', resolved_at=now() where device_id=$1 and src_ip_hash=$2", [
    deviceAnaId,
    hash,
  ]);

  const res = await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", apiKeyAna));
  const lista = await res.json();
  assert.equal(
    lista.some((o: { srcIpHash: string }) => o.srcIpHash === hash),
    false,
    "una orden ya aplicada no es 'pendiente'",
  );
});

// ── POST /api/mitigate/ack (la RPi) ─────────────────────────────────────────

prueba("ack sin Authorization responde 401", async () => {
  const res = await ACK(peticionDispositivo("http://localhost/api/mitigate/ack", null, { method: "POST", body: { orderId: 1, applied: "isolated" } }));
  assert.equal(res.status, 401);
});

prueba("ack con applied inválido responde 400", async () => {
  const { id } = await nuevaDeteccion(0.95, deviceAnaId, `test-iso-ack-bad-${Date.now()}`);
  const isoRes = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  const { orderId } = await isoRes.json();

  const res = await ACK(
    peticionDispositivo("http://localhost/api/mitigate/ack", apiKeyAna, { method: "POST", body: { orderId, applied: "bloqueado-a-mano" } }),
  );
  assert.equal(res.status, 400);
});

prueba("ack válido actualiza applied y resolvedAt", async () => {
  const { id, hash } = await nuevaDeteccion(0.95, deviceAnaId, `test-iso-ack-ok-${Date.now()}`);
  const isoRes = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  const { orderId } = await isoRes.json();

  const res = await ACK(
    peticionDispositivo("http://localhost/api/mitigate/ack", apiKeyAna, { method: "POST", body: { orderId, applied: "isolated" } }),
  );
  assert.equal(res.status, 200);

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.applied, "isolated");
  assert.ok(orden.resolved_at, "resolvedAt debe quedar poblado");
});

prueba("VULN pattern: el dispositivo de Beto no puede confirmar la orden de Ana", async () => {
  const { id, hash } = await nuevaDeteccion(0.95, deviceAnaId, `test-iso-ack-cross-${Date.now()}`);
  const isoRes = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  const { orderId } = await isoRes.json();

  const res = await ACK(
    peticionDispositivo("http://localhost/api/mitigate/ack", apiKeyBeto, { method: "POST", body: { orderId, applied: "isolated" } }),
  );
  assert.equal(res.status, 404, "el WHERE por device_id debe fallar aunque el orderId sea correcto");

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.applied, "pending", "la orden de Ana no debe moverse por el ack de Beto");
});

prueba("ack puede reportar failed con una nota, sin exponer la IP", async () => {
  const { id, hash } = await nuevaDeteccion(0.95, deviceAnaId, `test-iso-ack-failed-${Date.now()}`);
  const isoRes = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  const { orderId } = await isoRes.json();

  const res = await ACK(
    peticionDispositivo("http://localhost/api/mitigate/ack", apiKeyAna, {
      method: "POST",
      body: { orderId, applied: "failed", note: "hash fuera del mapa local (TTL vencido)" },
    }),
  );
  assert.equal(res.status, 200);

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.applied, "failed");
  assert.match(orden.note, /mapa local/);
});

// ── Ciclo completo: aislar -> confirmar -> liberar -> confirmar ─────────────

prueba("ciclo completo: pending -> ack isolated -> lift -> pending -> ack released", async () => {
  const hash = `test-iso-ciclo-${Date.now()}`;
  const { id } = await nuevaDeteccion(0.95, deviceAnaId, hash);

  const iso = await ISOLATE(peticionSesion("http://localhost/api/mitigate/isolate", { detectionId: id }, { userId: anaId }));
  const { orderId } = await iso.json();

  let pend = await (await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", apiKeyAna))).json();
  assert.ok(pend.some((o: { orderId: number }) => o.orderId === orderId));

  await ACK(peticionDispositivo("http://localhost/api/mitigate/ack", apiKeyAna, { method: "POST", body: { orderId, applied: "isolated" } }));

  pend = await (await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", apiKeyAna))).json();
  assert.equal(pend.some((o: { orderId: number }) => o.orderId === orderId), false, "ya no debe seguir pendiente");

  const lift = await LIFT(peticionSesion("http://localhost/api/mitigate/lift", { detectionId: id }, { userId: anaId }));
  assert.equal(lift.status, 200);

  pend = await (await PENDING(peticionDispositivo("http://localhost/api/mitigate/pending", apiKeyAna))).json();
  assert.ok(pend.some((o: { orderId: number; desired: string }) => o.orderId === orderId && o.desired === "released"));

  await ACK(peticionDispositivo("http://localhost/api/mitigate/ack", apiKeyAna, { method: "POST", body: { orderId, applied: "released" } }));

  const orden = await ordenDe(deviceAnaId, hash);
  assert.equal(orden.applied, "released");
});
