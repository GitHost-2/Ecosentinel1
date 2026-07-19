import { eq, and, gte, desc } from "drizzle-orm";
import { db } from "@/db";
import { devices, users, alertLog } from "@/db/schema";
import { sendAttackAlertEmail } from "@/lib/email";

// Máximo un correo cada 10 minutos por dispositivo. Sin esto, una
// ráfaga de detecciones (un ataque de volumen alto real, o un bug como
// el que ya vimos en producción) mandaría un correo por cada una.
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Manda una alerta por correo al dueño del dispositivo cuando detecta un
 * ataque, respetando el enfriamiento de 10 min. Nunca lanza — un fallo
 * al mandar la alerta no debe afectar la ingesta de la detección (ya se
 * insertó en la BD antes de llamar a esto).
 */
export async function maybeSendAttackAlert(params: {
  deviceId: number;
  detectionId: number;
  attackType: string;
  attackProb: number;
  protocol: string;
  dstPort: number;
  timestamp: Date;
}) {
  try {
    const [device] = await db.select().from(devices).where(eq(devices.id, params.deviceId)).limit(1);
    if (!device || !device.ownerUserId) {
      return; // dispositivo sin dueño asignado todavía, no hay a quién avisar
    }

    const [owner] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, device.ownerUserId))
      .limit(1);
    if (!owner) return;

    const cooldownSince = new Date(Date.now() - ALERT_COOLDOWN_MS);
    const [lastAlert] = await db
      .select({ sentAt: alertLog.sentAt })
      .from(alertLog)
      .where(and(eq(alertLog.deviceId, params.deviceId), gte(alertLog.sentAt, cooldownSince)))
      .orderBy(desc(alertLog.sentAt))
      .limit(1);

    if (lastAlert) {
      return; // dentro de la ventana de enfriamiento -- se agrupa silenciosamente
    }

    const result = await sendAttackAlertEmail({
      to: owner.email,
      deviceName: device.nombreCliente,
      attackType: params.attackType,
      attackProb: params.attackProb,
      protocol: params.protocol,
      dstPort: params.dstPort,
      timestamp: params.timestamp,
    });

    if (result.ok) {
      await db.insert(alertLog).values({
        deviceId: params.deviceId,
        detectionId: params.detectionId,
        recipientEmail: owner.email,
      });
    } else {
      console.error(`[alerts] fallo al enviar correo. deviceId=${params.deviceId} owner=${owner.email}:`, result.error);
    }
  } catch (err) {
    console.error(`[alerts] fallo al procesar alerta. deviceId=${params.deviceId}:`, err);
  }
}
