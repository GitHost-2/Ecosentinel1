import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { devices, users, alertLog } from "@/db/schema";
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
 * Se consulta el último intento del canal SIN filtrar por fecha en el SQL: la
 * ventana depende de si ese intento salió bien o mal, así que primero hay que
 * saber su `status` y luego decidir.
 */
async function wasAlertedRecently(deviceId: number, channel: "email" | "whatsapp") {
  const [lastAlert] = await db
    .select({ sentAt: alertLog.sentAt, status: alertLog.status })
    .from(alertLog)
    .where(and(eq(alertLog.deviceId, deviceId), eq(alertLog.channel, channel)))
    .orderBy(desc(alertLog.sentAt))
    .limit(1);
  return isWithinCooldown(lastAlert ?? null);
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

/** Manda alerta por correo y/o whatsapp al dueño del dispositivo, respetando el cooldown de cada canal. Nunca lanza. */
export async function maybeSendAttackAlert(params: AlertParams) {
  try {
    const [device] = await db.select().from(devices).where(eq(devices.id, params.deviceId)).limit(1);
    if (!device || !device.ownerUserId) {
      return; // sin dueño asignado, no hay a quién avisar
    }

    const [owner] = await db
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, device.ownerUserId))
      .limit(1);
    if (!owner) return;

    await Promise.all([
      sendEmailAlert(device.nombreCliente, owner.email, params),
      owner.phone ? sendWhatsappAlert(device.nombreCliente, owner.phone, params) : Promise.resolve(),
    ]);
  } catch (err) {
    console.error(`[alerts] fallo al procesar alerta. deviceId=${params.deviceId}:`, err);
  }
}

async function sendEmailAlert(deviceName: string, email: string, params: AlertParams) {
  if (await wasAlertedRecently(params.deviceId, "email")) return; // dentro del cooldown

  const result = await sendAttackAlertEmail({
    to: email,
    deviceName,
    attackType: params.attackType,
    attackProb: params.attackProb,
    protocol: params.protocol,
    dstPort: params.dstPort,
    timestamp: params.timestamp,
  });

  // Se registra SIEMPRE, también el fallo: si no, un canal averiado no tendría
  // cooldown y se reintentaría en cada detección.
  await registrarIntento(params, "email", email, result.ok ? "sent" : "failed");
  if (!result.ok) {
    console.error(`[alerts] fallo al enviar correo. deviceId=${params.deviceId} owner=${email}:`, result.error);
  }
}

async function sendWhatsappAlert(deviceName: string, phone: string, params: AlertParams) {
  if (await wasAlertedRecently(params.deviceId, "whatsapp")) return; // dentro del cooldown

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
    console.error(`[alerts] fallo al enviar whatsapp. deviceId=${params.deviceId} owner=${phone}:`, result.error);
  }
}
