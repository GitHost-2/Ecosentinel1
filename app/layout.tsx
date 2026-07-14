import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "EcoSentinel",
  description:
    "EcoSentinel: appliance de ciberseguridad perimetral con IA de borde. Detección de intrusiones en tiempo real para PyMEs, sin nube y sin latencia.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <meta name="theme-color" content="#0A0F14" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="icon" href="/icon-dark-32x32.png" sizes="32x32" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/icon-light-32x32.png" sizes="32x32" media="(prefers-color-scheme: light)" />
        <link rel="apple-touch-icon" href="/apple-icon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/css/styles.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
