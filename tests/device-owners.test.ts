/**
 * Coautoría de dispositivos (db/schema.ts: deviceOwners) — decisión del
 * 2026-08-16: el dispositivo de demo es compartido, no "un dispositivo por
 * cliente". Antes de este cambio, un usuario recién registrado veía el
 * dashboard vacío (0 dispositivos) porque `devices.ownerUserId` solo apunta
 * a uno. Estas pruebas validan que:
 *
 *   1. Registrarse hace al usuario coautor de TODOS los dispositivos ya
 *      existentes (visible en GET /api/devices y GET /api/stats).
 *   2. Un dispositivo dado de alta DESPUÉS también aparece para cuentas ya
 *      registradas (simétrico — ver db/create-device.ts y db/seed.ts).
 *   3. Un coautor por registro tiene las MISMAS acciones que el dueño
 *      original: puede pedir "Aislar IP" sobre una detección de alta
 *      confianza (no solo verla).
 *
 * Corren los handlers REALES contra el Postgres LOCAL de pruebas (ver
 * tests/db-local.ts) — igual que mitigate.test.ts e isolation.test.ts, por
 * la misma razón: el scoping es un JOIN de Postgres, no algo que un doble en
 * memoria reproduzca fielmente. Si no hay Postgres local, se salta con el
 * motivo a la vista.
 */
import { pool, closePool, databaseUnavailableReason } from "./db-local";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { POST as REGISTER } from "../app/api/auth/register/route";
import { GET as DEVICES } from "../app/api/devices/route";
import { GET as STATS } from "../app/api/stats/route";
import { POST as ISOLATE } from "../app/api/mitigate/isolate/route";

let sinBase: string | false = "sin inicializar";
let deviceExistenteId = 0;

before(async () => {
  sinBase = await databaseUnavailableReason();
  if (sinBase) return;

  // Aislado por prefijo, como el resto de la suite.
  await pool.query(
    "delete from device_owners where device_id in (select id from devices where api_key_hash like 'test-devown-%')",
  );
  await pool.query("delete from detections where src_ip_hash like 'test-devown-%'");
  await pool.query("delete from devices where api_key_hash like 'test-devown-%'");
  await pool.query("delete from users where email like 'test-devown-%'");

  const dev = await pool.query(
    "insert into devices (nombre_cliente,api_key_hash) values ('rpi-demo-devown','test-devown-k1') returning id",
  );
  deviceExistenteId = dev.rows[0].id;
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

/** Cookie de sesión a partir de un Set-Cookie de respuesta (formato "nombre=valor; ..."). */
function cookieDe(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

async function registrar(email: string) {
  const res = await REGISTER(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "Coautor SA", email, password: "contraseña-larga-1" }),
    }),
  );
  const body = await res.json();
  return { status: res.status, body, cookie: cookieDe(res) };
}

prueba("registrarse hace al usuario coautor de un dispositivo ya existente", async () => {
  const { status, cookie } = await registrar("test-devown-nuevo@ejemplo.test");
  assert.equal(status, 201);

  const res = await DEVICES(new Request("http://localhost/api/devices", { headers: { cookie } }));
  const devices = await res.json();
  assert.equal(res.status, 200);
  assert.ok(
    devices.some((d: { id: number }) => d.id === deviceExistenteId),
    "el dispositivo creado ANTES del registro debe aparecer para la cuenta nueva",
  );
});

prueba("los contadores (/api/stats) también son visibles para la cuenta nueva, no solo el dueño original", async () => {
  await pool.query(
    `insert into detections (device_id,timestamp,attack_prob,protocol,attack_type,src_ip_hash,dst_port)
     values ($1, now(), 0.9, 'TCP', 'Port Scanning', 'test-devown-hash', 22)`,
    [deviceExistenteId],
  );

  const { cookie } = await registrar("test-devown-contadores@ejemplo.test");
  const res = await STATS(new Request("http://localhost/api/stats", { headers: { cookie } }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.detected >= 1, "una cuenta recién registrada debe ver detecciones del dispositivo compartido, no 0");
});

prueba("un dispositivo dado de alta DESPUÉS del registro también aparece (simétrico)", async () => {
  const { cookie } = await registrar("test-devown-simetria@ejemplo.test");

  // La base local de pruebas es compartida entre archivos (no se trunca
  // entre suites), así que no se asume una tabla `devices` vacía -- se
  // compara solo lo que le concierne a este dispositivo nuevo.
  let res = await DEVICES(new Request("http://localhost/api/devices", { headers: { cookie } }));
  let devices = await res.json();
  assert.ok(devices.some((d: { id: number }) => d.id === deviceExistenteId));
  assert.ok(!devices.some((d: { nombreCliente: string }) => d.nombreCliente === "rpi-demo-devown-2"));

  // Simula lo que hace db/create-device.ts: backfill de coautoría a TODOS
  // los usuarios ya registrados.
  const dev2 = await pool.query(
    "insert into devices (nombre_cliente,api_key_hash) values ('rpi-demo-devown-2','test-devown-k2') returning id",
  );
  const usuarios = await pool.query("select id from users");
  for (const u of usuarios.rows) {
    await pool.query("insert into device_owners (device_id,user_id) values ($1,$2) on conflict do nothing", [
      dev2.rows[0].id,
      u.id,
    ]);
  }

  res = await DEVICES(new Request("http://localhost/api/devices", { headers: { cookie } }));
  devices = await res.json();
  assert.ok(
    devices.some((d: { nombreCliente: string }) => d.nombreCliente === "rpi-demo-devown-2"),
    "el dispositivo nuevo debe verse sin que la cuenta tenga que hacer nada",
  );
});

prueba("un coautor por registro tiene las MISMAS acciones que el dueño original: puede pedir Aislar IP", async () => {
  const { rows } = await pool.query(
    `insert into detections (device_id,timestamp,attack_prob,protocol,attack_type,src_ip_hash,dst_port)
     values ($1, now(), 0.95, 'TCP', 'Brute Force', 'test-devown-hash-iso', 22) returning id`,
    [deviceExistenteId],
  );
  const detectionId = rows[0].id as number;

  const { cookie } = await registrar("test-devown-aislar@ejemplo.test");
  const res = await ISOLATE(
    new Request("http://localhost/api/mitigate/isolate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ detectionId }),
    }),
  );
  const body = await res.json();
  assert.equal(res.status, 200, `una cuenta coautora por registro debe poder pedir aislamiento: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
});

prueba("dos cuentas registradas por separado son AMBAS coautoras (no se pisan)", async () => {
  const a = await registrar("test-devown-multi-a@ejemplo.test");
  const b = await registrar("test-devown-multi-b@ejemplo.test");

  for (const { cookie } of [a, b]) {
    const res = await DEVICES(new Request("http://localhost/api/devices", { headers: { cookie } }));
    const devices = await res.json();
    assert.ok(devices.some((d: { id: number }) => d.id === deviceExistenteId));
  }
});
