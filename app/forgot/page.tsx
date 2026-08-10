import type { Metadata } from "next";
import Script from "next/script";
import { AuthShell } from "../_components/auth-shell";

export const metadata: Metadata = {
  title: "Recuperar contraseña · EcoSentinel",
  description: "Solicita un enlace para restablecer la contraseña de tu cuenta de EcoSentinel.",
  // Un buscador no tiene nada que indexar aquí.
  robots: { index: false, follow: false },
};

export default function ForgotPage() {
  return (
    <AuthShell
      title="¿Olvidaste tu contraseña?"
      subtitle="Escribe tu correo y te mandamos un enlace para elegir una nueva."
    >
      <form id="forgotForm" noValidate>
        <div className="field">
          <label htmlFor="forgotEmail">Correo electrónico</label>
          <input
            type="email"
            id="forgotEmail"
            name="email"
            placeholder="tucorreo@ejemplo.com"
            autoComplete="email"
            inputMode="email"
          />
          <div className="error-msg" data-error="email"></div>
        </div>
        <button type="submit" className="btn btn-teal btn-block btn-lg">
          Enviar enlace
        </button>
        {/* role=status: el lector de pantalla anuncia el resultado sin robar el foco. */}
        <p className="auth-note" id="forgotNote" role="status" aria-live="polite"></p>
      </form>

      <p className="auth-switch">
        <a href="/">← Volver al inicio</a>
      </p>

      <Script src="/js/auth-forms.js" strategy="afterInteractive" />
    </AuthShell>
  );
}
