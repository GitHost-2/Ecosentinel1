import fs from "node:fs";
import path from "node:path";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Script from "next/script";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

const dashboardHtml = fs.readFileSync(
  path.join(process.cwd(), "app/_fragments/dashboard.html"),
  "utf8",
);

export default async function DashboardPage() {
  // El dashboard era accesible sin iniciar sesión (no había middleware ni
  // verificación de servidor); la "sesión" solo existía en sessionStorage.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/");

  return (
    <div className="dash-body">
      <div dangerouslySetInnerHTML={{ __html: dashboardHtml }} />

      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrambleTextPlugin.min.js" strategy="beforeInteractive" />
      <Script src="/js/dashboard.js" strategy="afterInteractive" />
      <Script src="/js/password-toggle.js" strategy="afterInteractive" />
    </div>
  );
}
