import { Resend } from "resend";

// ⚠️ RESEND ESTÁ EN SANDBOX Y SOLO ENTREGA A eduardoedu12x@gmail.com.
//
// Sin dominio propio verificado en Resend, `ALERT_FROM_EMAIL` no está
// configurada y el remitente es `onboarding@resend.dev`, que SOLO entrega al
// correo de la cuenta de Resend (eduardoedu12x@gmail.com). Cualquier otro
// destinatario recibe este rechazo del proveedor:
//
//   "You can only send testing emails to your own email address
//    (eduardoedu12x@gmail.com). To send emails to other recipients, please
//    verify a domain at resend.com/domains"
//
// Para la DEMO es suficiente. Para clientes reales hace falta un dominio
// propio: `ecosentinel.com` NO es nuestro (está aparcado y en venta en
// Afternic), así que no hay DNS que arreglar — hay que registrar uno, crear
// los registros DKIM/SPF/MX que pide Resend y configurar ALERT_FROM_EMAIL.
// Pendiente ya documentado (README_ECOSENTINEL §5.16 y §6.2).
//
// Esto afecta por igual a las alertas de ataque y al correo de "olvidé mi
// contraseña": un usuario con otro correo NO recibirá su enlace de reset.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "EcoSentinel <onboarding@resend.dev>";

/** Default del panel cuando no hay DASHBOARD_URL. Lo reutiliza lib/password-reset.ts. */
export const DEFAULT_DASHBOARD_URL = "https://ecosentinel1.vercel.app/dashboard";
const DASHBOARD_URL = process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL;

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
    subject: `EcoSentinel detectó ${params.attackType} en ${params.deviceName}`,
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

/**
 * Correo de "olvidé mi contraseña" (ver app/api/auth/forgot/route.ts).
 *
 * Recibe la URL ya armada — quien la construye es `lib/password-reset.ts` —
 * para que este módulo siga siendo solo el transporte.
 *
 * ⚠️ Recordatorio del bloque de arriba: con Resend en sandbox esto SOLO llega
 * a eduardoedu12x@gmail.com. Si la demo se hace con otra cuenta, el enlace no
 * llegará por correo (el flujo del servidor sí funciona: el token se emite y
 * `/reset?token=…` lo acepta).
 */
export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const resend = getClient();
  if (!resend) {
    return { ok: false, error: "RESEND_API_KEY no configurado" };
  }

  const { data, error } = await resend.emails.send({
    from: ALERT_FROM_EMAIL,
    to: params.to,
    subject: "Restablece tu contraseña de EcoSentinel",
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; color:#1a1a1a;">
        <h2 style="color:#2F8F86; margin-bottom:4px;">Restablece tu contraseña</h2>
        <p style="color:#444;">
          Recibimos una solicitud para restablecer la contraseña de tu cuenta de EcoSentinel.
          Abre este enlace para elegir una nueva:
        </p>
        <p style="margin:24px 0;">
          <a href="${params.resetUrl}"
             style="display:inline-block; background:#2F8F86; color:#ffffff; text-decoration:none;
                    padding:14px 24px; border-radius:10px; font-weight:600;">
            Elegir nueva contraseña
          </a>
        </p>
        <p style="color:#666; font-size:13px; word-break:break-all;">
          Si el botón no funciona, copia y pega esta dirección en tu navegador:<br>
          ${params.resetUrl}
        </p>
        <p style="color:#999; font-size:12px; margin-top:24px;">
          El enlace caduca en ${params.expiresInMinutes} minutos y solo se puede usar una vez.
          Si no pediste este cambio, ignora este correo: tu contraseña actual sigue funcionando.
        </p>
      </div>
    `,
  });

  if (error) {
    return { ok: false, error: JSON.stringify(error) };
  }
  return { ok: true, id: data?.id };
}
