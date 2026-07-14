import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

const landingHtml = fs.readFileSync(
  path.join(process.cwd(), "app/_fragments/landing.html"),
  "utf8",
);

export default function LandingPage() {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: landingHtml }} />

      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrollTrigger.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrollToPlugin.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/SplitText.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrambleTextPlugin.min.js" strategy="beforeInteractive" />
      <Script src="/js/animations.js" strategy="afterInteractive" />
      <Script src="/js/auth.js" strategy="afterInteractive" />
    </>
  );
}
