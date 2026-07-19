import { Resend } from "resend";

// Necesitas una cuenta en resend.com y una API key en RESEND_API_KEY.
// Para mandar a CUALQUIER correo de cliente (no solo al tuyo propio)
// hace falta verificar un dominio propio en Resend — mientras no lo
// hagas, el modo sandbox de Resend solo entrega al correo con el que te
// registraste ahí. ALERT_FROM_EMAIL debe ser una dirección de ese
// dominio verificado (ej. alertas@tudominio.com).
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "EcoSentinel <onboarding@resend.dev>";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://ecosentinel1.vercel.app/dashboard";

let client: Resend | null = null;
function getClient() {
  if (!RESEND_API_KEY) return null;
  if (!client) client = new Resend(RESEND_API_KEY);
  return client;
}

export async function sendAttackAlertEmail(params: {
  to: string;
  deviceName: string;
  attackType: string;
  attackProb: number;
  protocol: string;
  dstPort: number;
  timestamp: Date;
}): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const resend = getClient();
  if (!resend) {
    return { ok: false, error: "RESEND_API_KEY no configurado" };
  }

  const pct = Math.round(params.attackProb * 100);

  const { data, error } = await resend.emails.send({
    from: ALERT_FROM_EMAIL,
    to: params.to,
    subject: `⚠️ EcoSentinel detectó ${params.attackType} en ${params.deviceName}`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; color:#1a1a1a;">
        <h2 style="color:#C4694A; margin-bottom:4px;">Ataque detectado: ${params.attackType}</h2>
        <p style="color:#444;">Tu dispositivo <strong>${params.deviceName}</strong> detectó un evento sospechoso en tu red.</p>
        <table style="width:100%; border-collapse: collapse; margin: 16px 0; font-size:14px;">
          <tr><td style="padding:6px 0; color:#666; width:140px;">Probabilidad</td><td><strong>${pct}%</strong></td></tr>
          <tr><td style="padding:6px 0; color:#666;">Protocolo</td><td>${params.protocol}</td></tr>
          <tr><td style="padding:6px 0; color:#666;">Puerto destino</td><td>${params.dstPort}</td></tr>
          <tr><td style="padding:6px 0; color:#666;">Hora</td><td>${params.timestamp.toLocaleString("es-MX")}</td></tr>
        </table>
        <p><a href="${DASHBOARD_URL}" style="color:#2F8F86;">Ver el detalle en tu dashboard →</a></p>
        <p style="color:#999; font-size:12px; margin-top:24px;">
          Si hay varias detecciones seguidas no recibirás un correo por cada una (máximo uno
          cada 10 minutos por dispositivo) — el dashboard siempre muestra el detalle completo.
        </p>
      </div>
    `,
  });

  if (error) {
    return { ok: false, error: JSON.stringify(error) };
  }
  return { ok: true, id: data?.id };
}
