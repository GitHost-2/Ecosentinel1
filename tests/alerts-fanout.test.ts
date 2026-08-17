/**
 * Cooldown de alertas con VARIOS destinatarios (lib/alerts.ts).
 *
 * Bug real encontrado el 2026-08-16 al revisar el fan-out a coautores
 * ([[Coautoría de dispositivos]]): `wasAlertedRecently()` tomaba "la fila
 * más reciente de alert_log por sent_at, sin importar su status". Con varios
 * coautores, `maybeSendAttackAlert` manda a todos en paralelo
 * (`Promise.all`), así que un envío CON ÉXITO y uno FALLIDO casi simultáneos
 * pueden escribir sus filas en cualquier orden -- cuál queda "más reciente"
 * era una carrera, y si ganaba la fila `failed`, el dispositivo entero
 * pasaba a reintentar cada 2 min en vez de cada 10, aunque alguien SÍ
 * hubiera recibido la alerta.
 *
 * El fix: mirar el último envío CON ÉXITO y el último FALLIDO por
 * separado -- si cualquiera tuvo éxito hace poco, se calla 10 min
 * completos, sin importar si hay un fallo más reciente todavía.
 *
 * Corre contra el Postgres LOCAL de pruebas (ver tests/db-local.ts). Sin
 * RESEND_API_KEY/TWILIO_* configuradas (tests/setup-env.ts no las pone), TODO
 * intento real que haga maybeSendAttackAlert falla y escribe 'failed' -- eso
 * es justo lo que permite probar la suspensión sin credenciales reales: se
 * siembra un 'sent' reciente a mano (simulando una ronda previa donde SÍ
 * hubo éxito) y se confirma que una detección nueva NO agrega filas nuevas,
 * aunque también se siembre un 'failed' más reciente todavía (la carrera).
 *
 * Cada prueba usa su PROPIO dispositivo: `maybeSendAttackAlert` dispara
 * SIEMPRE los dos canales (email y whatsapp) a la vez, así que reusar un
 * mismo dispositivo entre pruebas deja filas residuales de un canal que no
 * es el que esa prueba está mirando.
 */
import { pool, closePool, databaseUnavailableReason } from "./db-local";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { maybeSendAttackAlert } from "../lib/alerts";

let sinBase: string | false = "sin inicializar";
let userId = 0;
let contador = 0;

before(async () => {
  sinBase = await databaseUnavailableReason();
  if (sinBase) return;

  await pool.query(
    "delete from alert_log where device_id in (select id from devices where api_key_hash like 'test-fanout-%')",
  );
  await pool.query(
    "delete from device_owners where device_id in (select id from devices where api_key_hash like 'test-fanout-%')",
  );
  await pool.query("delete from detections where src_ip_hash like 'test-fanout-%'");
  await pool.query("delete from devices where api_key_hash like 'test-fanout-%'");
  await pool.query("delete from users where email like 'test-fanout-%'");

  // Con teléfono: sin él, sendWhatsappAlert no intenta nada (lista vacía) y
  // las pruebas de whatsapp de abajo no probarían el cooldown, sino solo la
  // ausencia de destinatarios.
  const u = await pool.query(
    "insert into users (company,email,password_hash,phone) values ('Fanout SA','test-fanout-user@ejemplo.test','x','+5215500000000') returning id",
  );
  userId = u.rows[0].id;
});

after(async () => {
  await closePool();
});

function prueba(nombre: string, cuerpo: (deviceId: number) => Promise<void> | void) {
  test(nombre, async (t) => {
    if (sinBase) {
      t.skip(sinBase);
      return;
    }
    contador += 1;
    const d = await pool.query(
      "insert into devices (nombre_cliente,api_key_hash) values ('rpi-fanout',$1) returning id",
      [`test-fanout-k${contador}`],
    );
    const deviceId = d.rows[0].id as number;
    await pool.query("insert into device_owners (device_id,user_id) values ($1,$2)", [deviceId, userId]);
    await cuerpo(deviceId);
  });
}

async function nuevaDeteccion(deviceId: number) {
  const { rows } = await pool.query(
    `insert into detections (device_id,timestamp,attack_prob,protocol,attack_type,src_ip_hash,dst_port)
     values ($1, now(), 0.9, 'TCP', 'Port Scanning', 'test-fanout-hash', 22) returning id`,
    [deviceId],
  );
  return rows[0].id as number;
}

async function filasAlertLog(deviceId: number, channel: "email" | "whatsapp") {
  const { rows } = await pool.query(
    "select status, sent_at from alert_log where device_id=$1 and channel=$2 order by sent_at",
    [deviceId, channel],
  );
  return rows as { status: string; sent_at: Date }[];
}

async function dispara(deviceId: number, detectionId: number) {
  await maybeSendAttackAlert({
    deviceId,
    detectionId,
    attackType: "Port Scanning",
    attackProb: 0.9,
    protocol: "TCP",
    dstPort: 22,
    timestamp: new Date(),
  });
}

prueba(
  "EL BUG: un 'sent' reciente sigue callando el canal aunque haya un 'failed' MÁS reciente todavía",
  async (deviceId) => {
    const idDeteccion = await nuevaDeteccion(deviceId);

    // Simula la ronda anterior: un coautor tuvo éxito hace 30s, otro falló
    // hace apenas 5s (el fallo es el más reciente de los dos -- la carrera).
    await pool.query(
      `insert into alert_log (device_id,detection_id,channel,recipient,status,sent_at)
       values ($1,$2,'email','ok@ejemplo.test','sent', now() - interval '30 seconds')`,
      [deviceId, idDeteccion],
    );
    await pool.query(
      `insert into alert_log (device_id,detection_id,channel,recipient,status,sent_at)
       values ($1,$2,'email','malo@ejemplo.test','failed', now() - interval '5 seconds')`,
      [deviceId, idDeteccion],
    );

    const antes = await filasAlertLog(deviceId, "email");
    assert.equal(antes.length, 2);

    await dispara(deviceId, idDeteccion);

    const despues = await filasAlertLog(deviceId, "email");
    assert.equal(
      despues.length,
      2,
      "el 'sent' de hace 30s debe callar el canal 10 min completos, sin importar que el 'failed' sea más reciente",
    );
  },
);

prueba("sin ningún 'sent' reciente, un 'failed' reciente sigue frenando (ventana corta)", async (deviceId) => {
  const idDeteccion = await nuevaDeteccion(deviceId);

  await pool.query(
    `insert into alert_log (device_id,detection_id,channel,recipient,status,sent_at)
     values ($1,$2,'whatsapp','malo@ejemplo.test','failed', now() - interval '5 seconds')`,
    [deviceId, idDeteccion],
  );

  const antes = await filasAlertLog(deviceId, "whatsapp");
  assert.equal(antes.length, 1);

  await dispara(deviceId, idDeteccion);

  const despues = await filasAlertLog(deviceId, "whatsapp");
  assert.equal(despues.length, 1, "un fallo de hace 5s sigue dentro del cooldown corto (2 min): no debe reintentar");
});

prueba("pasada la ventana corta del fallo, sin ningún 'sent' reciente, sí se reintenta", async (deviceId) => {
  const idDeteccion = await nuevaDeteccion(deviceId);

  await pool.query(
    `insert into alert_log (device_id,detection_id,channel,recipient,status,sent_at)
     values ($1,$2,'whatsapp','malo@ejemplo.test','failed', now() - interval '121 seconds')`,
    [deviceId, idDeteccion],
  );

  await dispara(deviceId, idDeteccion);

  const despues = await filasAlertLog(deviceId, "whatsapp");
  assert.ok(despues.length >= 2, "a los 2 min de un fallo, sin ningún éxito reciente, debe reintentar");
});
