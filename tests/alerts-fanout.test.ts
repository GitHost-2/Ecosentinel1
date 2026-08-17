/**
 * Fan-out de alertas a VARIOS destinatarios (lib/alerts.ts).
 *
 * Bug real encontrado el 2026-08-16 al revisar el fan-out a coautores
 * ([[Coautoría de dispositivos]]): `wasAlertedRecently()` tomaba "la fila
 * más reciente de alert_log por sent_at, sin importar su status". Con varios
 * coautores, `maybeSendAttackAlert` manda a todos en paralelo
 * (`Promise.all`), así que un envío CON ÉXITO y uno FALLIDO casi simultáneos
 * pueden escribir sus filas en cualquier orden -- cuál queda "más reciente"
 * era una carrera. El fix: mirar el último envío CON ÉXITO y el último
 * FALLIDO por separado. Esa lógica de `wasAlertedRecently` sigue en el
 * código sin cambios.
 *
 * 🔴 2026-08-17: por petición explícita del usuario, ALERT_COOLDOWN_MS y
 * FAILURE_COOLDOWN_MS quedaron en 0 -- ver lib/alerts.ts. Con ventana 0,
 * `isWithinCooldown` siempre devuelve false sin importar qué haya en
 * alert_log, así que la carrera de arriba ya no es observable: CUALQUIER
 * detección dispara un intento nuevo, gane quien gane la carrera. Las
 * pruebas de abajo reflejan ese estado actual (siempre se agrega fila
 * nueva); si se vuelve a activar el cooldown, deben revertirse a esperar
 * que NO se agregue fila nueva dentro de la ventana.
 *
 * Corre contra el Postgres LOCAL de pruebas (ver tests/db-local.ts). Sin
 * RESEND_API_KEY/TWILIO_* configuradas (tests/setup-env.ts no las pone), TODO
 * intento real que haga maybeSendAttackAlert falla y escribe 'failed'.
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
  "sin cooldown: un 'sent' reciente YA NO calla el canal, ni con un 'failed' más reciente todavía",
  async (deviceId) => {
    const idDeteccion = await nuevaDeteccion(deviceId);

    // Misma ronda anterior que antes disparaba la carrera: un coautor tuvo
    // éxito hace 30s, otro falló hace apenas 5s.
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
    assert.ok(
      despues.length > antes.length,
      "con ALERT_COOLDOWN_MS=0, la nueva detección debe intentar el envío pase lo que pase en alert_log",
    );
  },
);

prueba("sin cooldown: un 'failed' reciente YA NO frena el reintento", async (deviceId) => {
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
  assert.ok(despues.length > antes.length, "con FAILURE_COOLDOWN_MS=0, un fallo de hace 5s debe reintentar igual");
});

prueba("sin cooldown: detecciones seguidas sin ningún intento previo siempre reintentan", async (deviceId) => {
  const idDeteccion = await nuevaDeteccion(deviceId);

  await pool.query(
    `insert into alert_log (device_id,detection_id,channel,recipient,status,sent_at)
     values ($1,$2,'whatsapp','malo@ejemplo.test','failed', now() - interval '121 seconds')`,
    [deviceId, idDeteccion],
  );

  await dispara(deviceId, idDeteccion);

  const despues = await filasAlertLog(deviceId, "whatsapp");
  assert.ok(despues.length >= 2, "sin cooldown, un fallo de hace más de 2 min también debe reintentar");
});
