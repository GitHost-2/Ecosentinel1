import type { ReactNode } from "react";

/**
 * Marco compartido de las páginas sueltas de autenticación (/forgot y /reset).
 *
 * La landing y el dashboard se sirven como fragmentos HTML pegados con
 * `dangerouslySetInnerHTML`; aquí no hace falta ese rodeo porque son dos
 * formularios pequeños. Lo que sí se reutiliza es el CSS de siempre
 * (`public/css/styles.css`): `.field`, `.btn`, `.error-msg` y la paleta.
 *
 * `app/_components/` lleva guion bajo: Next lo trata como carpeta privada, así
 * que no crea ninguna ruta.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <a href="/" className="brand auth-brand" aria-label="EcoSentinel inicio">
          <span className="brand-mark" aria-hidden="true">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5l-8-3Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          ECOSENTINEL
        </a>
        <h1>{title}</h1>
        <p className="auth-sub">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}
