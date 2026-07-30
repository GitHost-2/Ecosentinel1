/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false, // no anunciar "X-Powered-By: Next.js"
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // El sitio no debe poder embeberse en un iframe ajeno (clickjacking).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // GSAP viene de cdnjs y el markup usa estilos inline, de ahí
          // 'unsafe-inline' en style-src y el host de cdnjs en script-src.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
