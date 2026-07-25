// Twilio WhatsApp Sandbox. Requiere TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y
// TWILIO_WHATSAPP_FROM (el número de sandbox, ej. "whatsapp:+14155238886").
// En sandbox, `to` solo entrega a números que ya se unieron enviando el
// código de unión al número de sandbox desde WhatsApp.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

function toWhatsappAddress(value: string) {
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

export async function sendAttackAlertWhatsapp(params: {
  to: string;
  deviceName: string;
  attackType: string;
  attackProb: number;
  protocol: string;
  dstPort: number;
  timestamp: Date;
}): Promise<{ ok: true; sid?: string } | { ok: false; error: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    return { ok: false, error: "Faltan variables de Twilio (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM)" };
  }

  const pct = Math.round(params.attackProb * 100);
  const body =
    `⚠️ EcoSentinel detectó *${params.attackType}* en ${params.deviceName}\n` +
    `Probabilidad: ${pct}%\n` +
    `Protocolo: ${params.protocol} · Puerto: ${params.dstPort}\n` +
    `Hora: ${params.timestamp.toLocaleString("es-MX")}\n` +
    `Detalle: ${process.env.DASHBOARD_URL || "https://ecosentinel1.vercel.app/dashboard"}`;

  const form = new URLSearchParams({
    From: toWhatsappAddress(TWILIO_WHATSAPP_FROM),
    To: toWhatsappAddress(params.to),
    Body: body,
  });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
    },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.message || `Twilio respondió ${res.status}` };
  }
  return { ok: true, sid: data.sid };
}
