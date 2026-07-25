import { eq, and, gte, desc } from "drizzle-orm";
import { db } from "@/db";
import { devices, users, alertLog } from "@/db/schema";
import { sendAttackAlertEmail } from "@/lib/email";
import { sendAttackAlertWhatsapp } from "@/lib/whatsapp";

// Máximo una alerta cada 10 min por dispositivo Y por canal (evita ráfagas de alertas).
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

type AlertParams = {
  deviceId: number;
  detectionId: number;
  attackType: string;
  attackProb: number;
  protocol: string;
  dstPort: number;
  timestamp: Date;
};

async function wasAlertedRecently(deviceId: number, channel: "email" | "whatsapp") {
  const cooldownSince = new Date(Date.now() - ALERT_COOLDOWN_MS);
  const [lastAlert] = await db
    .select({ sentAt: alertLog.sentAt })
    .from(alertLog)
    .where(and(eq(alertLog.deviceId, deviceId), eq(alertLog.channel, channel), gte(alertLog.sentAt, cooldownSince)))
    .orderBy(desc(alertLog.sentAt))
    .limit(1);
  return !!lastAlert;
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

  if (result.ok) {
    await db.insert(alertLog).values({ deviceId: params.deviceId, detectionId: params.detectionId, channel: "email", recipient: email });
  } else {
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

  if (result.ok) {
    await db.insert(alertLog).values({ deviceId: params.deviceId, detectionId: params.detectionId, channel: "whatsapp", recipient: phone });
  } else {
    console.error(`[alerts] fallo al enviar whatsapp. deviceId=${params.deviceId} owner=${phone}:`, result.error);
  }
}
