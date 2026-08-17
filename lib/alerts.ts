import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { devices, deviceOwners, users, alertLog } from "@/db/schema";
import { sendAttackAlertEmail } from "@/lib/email";
import { sendAttackAlertWhatsapp } from "@/lib/whatsapp";

// Máximo una alerta cada 10 min por dispositivo Y por canal (evita ráfagas de alertas).
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// Ventana tras un intento FALLIDO. Es más corta a propósito: si el fallo fue
// transitorio (un timeout del proveedor), esperar los 10 min completos
// retrasaría demasiado la alerta de un ataque real. Y es lo bastante larga para
// que un canal averiado no se reintente en cada detección — que es justo lo que
// pasaba antes de registrar los fallos: 91 llamadas a Resend en segundos
// durante una prueba de escaneo de puertos.
export const FAILURE_COOLDOWN_MS = 2 * 60 * 1000;

export type AlertStatus = "sent" | "failed";

/** Cuánto hay que esperar antes de volver a intentar, según cómo fue el último intento. */
export function cooldownWindowFor(status: AlertStatus): number {
  return status === "failed" ? FAILURE_COOLDOWN_MS : ALERT_COOLDOWN_MS;
}

/**
 * ¿El último intento por este canal es tan reciente que hay que callarse?
 * `lastAttempt` en null significa que nunca se intentó: hay que enviar.
 */
export function isWithinCooldown(
  lastAttempt: { sentAt: Date; status: string } | null,
  now: Date = new Date(),
): boolean {
  if (!lastAttempt) return false;
  const ventana = cooldownWindowFor(lastAttempt.status === "failed" ? "failed" : "sent");
  return now.getTime() - lastAttempt.sentAt.getTime() < ventana;
}

type AlertParams = {
  deviceId: number;
  detectionId: number;
  attackType: string;
  attackProb: number;
  protocol: string;
  dstPort: number;
  timestamp: Date;
};

/**
 * Se miran el ÚLTIMO envío CON ÉXITO y el ÚLTIMO envío FALLIDO por separado
 * -- NO "la fila más reciente de cualquier tipo, sin más".
 *
 * Por qué: desde [[Coautoría de dispositivos]] (deviceOwners), una ronda de
 * alertas manda a VARIOS destinatarios en paralelo (`Promise.all`), y cada
 * uno escribe su propia fila en `alert_log` casi al mismo tiempo. Con "toma
 * la fila más reciente por sent_at", cuál de esas filas casi-simultáneas
 * queda "la más reciente" es una carrera -- si un coautor falla (ej. Resend
 * en sandbox rechaza a cualquiera que no sea el dueño) y otro tiene éxito,
 * la ventana del dispositivo entero oscilaba de forma no determinista entre
 * los 10 min de un envío OK y los 2 min de un fallo.
 *
 * Con éxito y fallo mirados por separado: si CUALQUIERA tuvo éxito hace
 * poco, se calla los 10 min completos (ver isWithinCooldown); el fallo solo
 * manda si no hay ningún éxito reciente que lo tape.
 */
async function wasAlertedRecently(deviceId: number, channel: "email" | "whatsapp") {
  const [ultimoOk] = await db
    .select({ sentAt: alertLog.sentAt, status: alertLog.status })
    .from(alertLog)
    .where(and(eq(alertLog.deviceId, deviceId), eq(alertLog.channel, channel), eq(alertLog.status, "sent")))
    .orderBy(desc(alertLog.sentAt))
    .limit(1);
  if (isWithinCooldown(ultimoOk ?? null)) return true;

  const [ultimoFallo] = await db
    .select({ sentAt: alertLog.sentAt, status: alertLog.status })
    .from(alertLog)
    .where(and(eq(alertLog.deviceId, deviceId), eq(alertLog.channel, channel), eq(alertLog.status, "failed")))
    .orderBy(desc(alertLog.sentAt))
    .limit(1);
  return isWithinCooldown(ultimoFallo ?? null);
}

/** Deja constancia del intento, haya salido bien o mal. Nunca lanza: un fallo aquí no debe tumbar la ingesta. */
async function registrarIntento(
  params: AlertParams,
  channel: "email" | "whatsapp",
  recipient: string,
  status: AlertStatus,
) {
  try {
    await db.insert(alertLog).values({
      deviceId: params.deviceId,
      detectionId: params.detectionId,
      channel,
      recipient,
      status,
    });
  } catch (err) {
    console.error(`[alerts] no se pudo registrar el intento (${channel}/${status}). deviceId=${params.deviceId}:`, err);
  }
}

/**
 * Manda alerta por correo y/o whatsapp a TODOS los coautores del dispositivo
 * (`deviceOwners`, ver db/schema.ts -- ya no es un único dueño), respetando
 * el cooldown de cada canal. El cooldown es POR DISPOSITIVO Y CANAL, no por
 * destinatario: con varios coautores, se comprueba una sola vez por canal y,
 * si no está en cooldown, se manda a todos en esa ronda -- así N coautores
 * no multiplican por N las llamadas al proveedor. Nunca lanza.
 */
export async function maybeSendAttackAlert(params: AlertParams) {
  try {
    const [device] = await db.select().from(devices).where(eq(devices.id, params.deviceId)).limit(1);
    if (!device) return;

    const owners = await db
      .select({ email: users.email, phone: users.phone })
      .from(deviceOwners)
      .innerJoin(users, eq(users.id, deviceOwners.userId))
      .where(eq(deviceOwners.deviceId, params.deviceId));
    if (owners.length === 0) return; // sin coautores, no hay a quién avisar

    await Promise.all([
      sendEmailAlert(device.nombreCliente, owners.map((o) => o.email), params),
      sendWhatsappAlert(
        device.nombreCliente,
        owners.map((o) => o.phone).filter((p): p is string => !!p),
        params,
      ),
    ]);
  } catch (err) {
    console.error(`[alerts] fallo al procesar alerta. deviceId=${params.deviceId}:`, err);
  }
}

async function sendEmailAlert(deviceName: string, emails: string[], params: AlertParams) {
  if (emails.length === 0) return;
  if (await wasAlertedRecently(params.deviceId, "email")) return; // dentro del cooldown

  await Promise.all(
    emails.map(async (email) => {
      const result = await sendAttackAlertEmail({
        to: email,
        deviceName,
        attackType: params.attackType,
        attackProb: params.attackProb,
        protocol: params.protocol,
        dstPort: params.dstPort,
        timestamp: params.timestamp,
      });

      // Se registra SIEMPRE, también el fallo: si no, un canal averiado no
      // tendría cooldown y se reintentaría en cada detección. Se registra por
      // destinatario: si uno de varios coautores tiene el correo mal, no debe
      // silenciar la alerta de los demás en la próxima detección.
      await registrarIntento(params, "email", email, result.ok ? "sent" : "failed");
      if (!result.ok) {
        console.error(`[alerts] fallo al enviar correo. deviceId=${params.deviceId} to=${email}:`, result.error);
      }
    }),
  );
}

async function sendWhatsappAlert(deviceName: string, phones: string[], params: AlertParams) {
  if (phones.length === 0) return; // ningún coautor puso teléfono
  if (await wasAlertedRecently(params.deviceId, "whatsapp")) return; // dentro del cooldown

  await Promise.all(
    phones.map(async (phone) => {
      const result = await sendAttackAlertWhatsapp({
        to: phone,
        deviceName,
        attackType: params.attackType,
        attackProb: params.attackProb,
        protocol: params.protocol,
        dstPort: params.dstPort,
        timestamp: params.timestamp,
      });

      await registrarIntento(params, "whatsapp", phone, result.ok ? "sent" : "failed");
      if (!result.ok) {
        console.error(`[alerts] fallo al enviar whatsapp. deviceId=${params.deviceId} to=${phone}:`, result.error);
      }
    }),
  );
}
