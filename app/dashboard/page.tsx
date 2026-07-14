import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

const dashboardHtml = fs.readFileSync(
  path.join(process.cwd(), "app/_fragments/dashboard.html"),
  "utf8",
);

export default function DashboardPage() {
  return (
    <div className="dash-body">
      <div dangerouslySetInnerHTML={{ __html: dashboardHtml }} />

      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrambleTextPlugin.min.js" strategy="beforeInteractive" />
      <Script src="/js/dashboard.js" strategy="afterInteractive" />
    </div>
  );
}
