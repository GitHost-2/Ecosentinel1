import type { Metadata } from "next";
import Script from "next/script";
import { AuthShell } from "../_components/auth-shell";

export const metadata: Metadata = {
  title: "Nueva contraseña · EcoSentinel",
  description: "Elige una contraseña nueva para tu cuenta de EcoSentinel.",
  robots: { index: false, follow: false },
};

/**
 * El `token` NO se lee aquí sino en el navegador (public/js/auth-forms.js):
 * esta página se queda estática y el token no entra en el HTML renderizado.
 * El JS además lo borra de la barra de direcciones con `history.replaceState`
 * en cuanto lo lee, para que no quede a la vista ni se cuele en un `Referer`.
 */
export default function ResetPage() {
  return (
    <AuthShell
      title="Elige una contraseña nueva"
      subtitle="Escríbela dos veces. Mínimo 8 caracteres."
    >
      <form id="resetForm" noValidate>
        <div className="field">
          <label htmlFor="resetPassword">Nueva contraseña</label>
          <input
            type="password"
            id="resetPassword"
            name="password"
            placeholder="Mínimo 8 caracteres"
            autoComplete="new-password"
          />
          <div className="error-msg" data-error="password"></div>
        </div>
        <div className="field">
          <label htmlFor="resetConfirm">Confirmar contraseña</label>
          <input
            type="password"
            id="resetConfirm"
            name="confirm"
            placeholder="Repite la contraseña"
            autoComplete="new-password"
          />
          <div className="error-msg" data-error="confirm"></div>
        </div>
        <button type="submit" className="btn btn-teal btn-block btn-lg">
          Guardar contraseña
        </button>
        <p className="auth-note" id="resetNote" role="status" aria-live="polite"></p>
      </form>

      <p className="auth-switch">
        <a href="/forgot">Pedir otro enlace</a> · <a href="/">Volver al inicio</a>
      </p>

      <Script src="/js/password-toggle.js" strategy="afterInteractive" />
      <Script src="/js/auth-forms.js" strategy="afterInteractive" />
    </AuthShell>
  );
}
