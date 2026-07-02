/* ============================================================
   EcoSentinel — animations.js
   Toda la lógica de animación con GSAP:
   navbar, hero (canvas + char reveal + counters + parallax),
   tarjetas de amenazas (SVG timelines), pipeline, métricas y precios.
   ============================================================ */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

  /* ============================================================
     1. NAVBAR — transición transparente -> sólida con ScrollTrigger
  ============================================================= */
  function initNavbar() {
    const navbar = document.getElementById("navbar");
    if (!navbar) return;

    // ScrollTrigger que añade la clase .scrolled tras bajar 60px
    ScrollTrigger.create({
      start: "60px top",
      onUpdate: (self) => {
        if (self.scroll() > 60) navbar.classList.add("scrolled");
        else navbar.classList.remove("scrolled");
      },
      onToggle: (self) => {
        if (self.progress > 0) navbar.classList.add("scrolled");
      },
    });

    // Menú móvil
    const toggle = document.getElementById("navToggle");
    const links = document.getElementById("navLinks");
    if (toggle && links) {
      toggle.addEventListener("click", () => {
        const open = links.classList.toggle("mobile-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      links.querySelectorAll("a").forEach((a) =>
        a.addEventListener("click", () => {
          links.classList.remove("mobile-open");
          toggle.setAttribute("aria-expanded", "false");
        })
      );
    }
  }

  /* ============================================================
     2. SMOOTH SCROLL — links de navegación con ScrollToPlugin
  ============================================================= */
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"], [data-scroll]').forEach((link) => {
      link.addEventListener("click", (e) => {
        const href = link.getAttribute("href");
        if (!href || !href.startsWith("#") || href === "#") return;
        const target = document.querySelector(href);
        if (!target) return;
        e.preventDefault();
        if (REDUCED) {
          target.scrollIntoView();
          return;
        }
        gsap.to(window, { duration: 1, scrollTo: { y: target, offsetY: 64 }, ease: "power2.inOut" });
      });
    });
  }

  /* ============================================================
     3. HERO — revelado del título carácter por carácter
  ============================================================= */
  function splitTitleIntoChars(el) {
    const words = el.textContent.trim().split(/\s+/);
    el.innerHTML = "";
    const spans = [];
    words.forEach((word, wi) => {
      const wordSpan = document.createElement("span");
      wordSpan.className = "word";
      [...word].forEach((ch) => {
        const c = document.createElement("span");
        c.className = "char";
        c.textContent = ch;
        wordSpan.appendChild(c);
        spans.push(c);
      });
      el.appendChild(wordSpan);
      if (wi < words.length - 1) el.appendChild(document.createTextNode(" "));
    });
    return spans;
  }

  function initHeroText() {
    const title = document.getElementById("heroTitle");
    if (!title) return;
    // Preservamos el <span class="accent"> resaltando "Inteligencia Artificial"
    const accent = title.querySelector(".accent");
    const accentText = accent ? accent.textContent : "";

    // Reconstruimos el título manteniendo el color de acento en las palabras finales
    title.textContent = title.textContent; // colapsa a texto plano
    const chars = splitTitleIntoChars(title);

    // Re-aplicamos color de acento a los caracteres que pertenecen al texto resaltado
    if (accentText) {
      const full = title.textContent;
      const startIdx = full.indexOf(accentText);
      if (startIdx >= 0) {
        // contamos solo caracteres no-espacio
        let visibleIdx = 0;
        const accentVisible = accentText.replace(/\s/g, "").length;
        const accentStartVisible = full.slice(0, startIdx).replace(/\s/g, "").length;
        chars.forEach((c) => {
          if (visibleIdx >= accentStartVisible && visibleIdx < accentStartVisible + accentVisible) {
            c.style.color = "var(--teal-light)";
          }
          visibleIdx++;
        });
      }
    }

    if (REDUCED) {
      gsap.set(chars, { opacity: 1, y: 0 });
      return;
    }

    gsap.from(chars, {
      opacity: 0,
      y: 40,
      rotateX: -60,
      duration: 0.7,
      ease: "back.out(1.7)",
      stagger: 0.03,
      delay: 0.3,
    });
  }

  /* ============================================================
     4. HERO — contadores animados desde 0 con snap
  ============================================================= */
  function initCounters() {
    document.querySelectorAll("[data-count]").forEach((el) => {
      const target = parseFloat(el.getAttribute("data-count"));
      const decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
      const prefix = (el.getAttribute("data-prefix") || "").replace("&lt;", "<");
      const suffix = el.getAttribute("data-suffix") || "";
      const snapInc = decimals > 0 ? parseFloat("0." + "0".repeat(decimals - 1) + "1") : 1;
      const obj = { val: 0 };

      const render = () => {
        el.textContent = prefix + obj.val.toFixed(decimals) + suffix;
      };

      if (REDUCED) {
        obj.val = target;
        render();
        return;
      }

      gsap.to(obj, {
        val: target,
        duration: 2,
        ease: "power2.out",
        delay: 0.8,
        snap: { val: snapInc },
        onUpdate: render,
      });
    });
  }

  /* ============================================================
     5. HERO — parallax sutil con ScrollTrigger
  ============================================================= */
  function initHeroParallax() {
    if (REDUCED) return;
    const inner = document.querySelector(".hero-inner");
    const canvas = document.getElementById("hero-canvas");
    if (inner) {
      gsap.to(inner, {
        y: 120,
        opacity: 0.5,
        ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
      });
    }
    if (canvas) {
      gsap.to(canvas, {
        y: 60,
        ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
      });
    }
  }

  /* ============================================================
     6. HERO — canvas: topología de red viva con ciclo de infección
  ============================================================= */
  function initHeroCanvas() {
    const canvas = document.getElementById("hero-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let w, h, dpr;
    const nodes = [];
    const NODE_COUNT = window.innerWidth < 640 ? 26 : 52;
    const LINK_DIST = window.innerWidth < 640 ? 120 : 160;
    const TEAL = "#5EEAD4";
    const CORAL = "#FF6B4A";

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function makeNodes() {
      nodes.length = 0;
      for (let i = 0; i < NODE_COUNT; i++) {
        nodes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
          r: 1.6 + Math.random() * 1.8,
          infected: false,
          infectT: 0,
          isolated: false,
        });
      }
    }

    // Ciclo de infección: cada cierto tiempo un nodo se infecta,
    // parpadea, es aislado, y luego vuelve a la normalidad.
    let flashOn = false;
    function infectionCycle() {
      if (REDUCED) return;
      const healthy = nodes.filter((n) => !n.infected);
      if (healthy.length) {
        const victim = healthy[Math.floor(Math.random() * healthy.length)];
        victim.infected = true;
        victim.infectT = performance.now();
        // parpadeo de las líneas conectadas
        gsap.to({ v: 0 }, {
          v: 1,
          duration: 0.15,
          repeat: 5,
          yoyo: true,
          onUpdate() {
            flashOn = Math.random() > 0.5;
          },
          onComplete() {
            // aislar visualmente
            victim.isolated = true;
            gsap.delayedCall(1.2, () => {
              // recuperación
              victim.infected = false;
              victim.isolated = false;
            });
          },
        });
      }
      gsap.delayedCall(2.6 + Math.random() * 1.5, infectionCycle);
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      // líneas
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < 0 || a.x > w) a.vx *= -1;
        if (a.y < 0 || a.y > h) a.vy *= -1;

        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK_DIST) {
            const connectedToInfected = (a.infected && !a.isolated) || (b.infected && !b.isolated);
            let alpha = (1 - dist / LINK_DIST) * 0.5;
            // Si un extremo está aislado, no dibujamos la línea (desconexión)
            if (a.isolated || b.isolated) continue;
            ctx.strokeStyle = connectedToInfected
              ? `rgba(255,107,74,${flashOn ? alpha * 1.6 : alpha * 0.5})`
              : `rgba(94,234,212,${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      // nodos
      for (const n of nodes) {
        let color = TEAL;
        if (n.infected) color = CORAL;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.isolated ? n.r + 1 : n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.infected) {
          // halo del nodo infectado
          ctx.strokeStyle = `rgba(255,107,74,${n.isolated ? 0.9 : 0.4})`;
          ctx.lineWidth = n.isolated ? 2 : 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      requestAnimationFrame(draw);
    }

    resize();
    makeNodes();
    window.addEventListener("resize", () => {
      resize();
      makeNodes();
    });

    if (REDUCED) {
      // estado estático: solo dibujar una vez
      draw = function staticDraw() {
        ctx.clearRect(0, 0, w, h);
        for (const n of nodes) {
          ctx.fillStyle = TEAL;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      draw();
      return;
    }

    requestAnimationFrame(draw);
    gsap.delayedCall(1.5, infectionCycle);
  }

  /* ============================================================
     7. AMENAZAS — entrada de tarjetas con stagger + SVG loops
  ============================================================= */
  function initThreatCards() {
    const cards = gsap.utils.toArray(".threat-card");
    if (!REDUCED && cards.length) {
      gsap.from(cards, {
        y: 60,
        opacity: 0,
        duration: 0.7,
        ease: "power3.out",
        stagger: 0.15,
        scrollTrigger: { trigger: "#amenazas", start: "top 75%" },
      });
    }
    if (!REDUCED) {
      threatRansomware();
      threatDDoS();
      threatPortScan();
      threatBotnet();
      threatBruteForce();
      threatSpoofing();
    }
  }

  // a) Ransomware: archivo -> se cifra -> candado -> escudo descifra
  function threatRansomware() {
    const scope = document.querySelector('[data-anim="ransomware"]');
    if (!scope) return;
    const lines = scope.querySelectorAll("#rw-lines line");
    const lock = scope.querySelector("#rw-lock");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
    tl.to(lines, { stroke: "#FF6B4A", duration: 0.3, stagger: 0.12 })
      .to(lines, { attr: { x2: (i, t) => 80 + Math.random() * 40 }, duration: 0.2, repeat: 3, yoyo: true }, "<")
      .to(lock, { opacity: 1, y: -4, duration: 0.4, ease: "back.out(2)" })
      .to({}, { duration: 0.6 })
      .to(lock, { opacity: 0, duration: 0.4 })
      .to(lines, { stroke: "#5EEAD4", attr: { x2: (i) => (i === 2 ? 108 : 120) }, duration: 0.4 });
  }

  // b) DDoS: paquetes -> servidor parpadea rojo -> escudo -> rebote
  function threatDDoS() {
    const scope = document.querySelector('[data-anim="ddos"]');
    if (!scope) return;
    const packets = scope.querySelectorAll(".pk");
    const server = scope.querySelector("#ddos-server");
    const shield = scope.querySelector("#ddos-shield");
    const home = [];
    packets.forEach((p) => home.push({ x: p.getAttribute("cx"), y: p.getAttribute("cy") }));

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    tl.to(packets, { attr: { cx: 100, cy: 75 }, duration: 0.7, ease: "power1.in", stagger: 0.05 })
      .to(server, { stroke: "#FF6B4A", duration: 0.15, repeat: 3, yoyo: true }, "<0.3")
      .set(shield, { opacity: 1, scale: 0.6, transformOrigin: "100px 75px" })
      .to(shield, { scale: 1, duration: 0.3, ease: "back.out(2)" })
      .to(packets, {
        attr: { cx: (i) => home[i].x, cy: (i) => home[i].y },
        duration: 0.6,
        ease: "power2.out",
      })
      .to(shield, { opacity: 0, duration: 0.3 })
      .to(server, { stroke: "#5EEAD4", duration: 0.2 }, "<");
  }

  // c) Port Scanning: scanner recorre puertos, los ilumina, EcoSentinel bloquea
  function threatPortScan() {
    const scope = document.querySelector('[data-anim="portscan"]');
    if (!scope) return;
    const scanner = scope.querySelector("#ps-scanner");
    const ports = scope.querySelectorAll(".port rect");
    const xs = [41, 83, 125, 167];
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.7 });
    xs.forEach((x, i) => {
      tl.to(scanner, { attr: { x1: x, x2: x }, duration: 0.35, ease: "power1.inOut" })
        .to(ports[i], { stroke: "#FF6B4A", duration: 0.15 }, "<0.1");
    });
    tl.to(scanner, { stroke: "#0EA5A6", duration: 0.2 })
      .to(ports, { stroke: "#5EEAD4", duration: 0.4, stagger: 0.05 })
      .to(scanner, { stroke: "#FF6B4A", duration: 0.2 });
  }

  // d) Botnet: dispositivos se infectan, forman red hacia C&C, EcoSentinel aísla
  function threatBotnet() {
    const scope = document.querySelector('[data-anim="botnet"]');
    if (!scope) return;
    const devices = scope.querySelectorAll(".bn-device rect");
    const links = scope.querySelector("#bn-links");
    const cnc = scope.querySelector("#bn-cnc");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
    tl.to(devices, { stroke: "#FF6B4A", duration: 0.3, stagger: 0.25 })
      .to(links, { opacity: 1, duration: 0.3 }, "<0.2")
      .to(cnc, { stroke: "#FF6B4A", scale: 1.1, transformOrigin: "100px 125px", duration: 0.2, repeat: 2, yoyo: true })
      .to({}, { duration: 0.4 })
      .to(links, { opacity: 0, duration: 0.3 }) // EcoSentinel corta las conexiones
      .to(devices, { stroke: "#5EEAD4", duration: 0.4, stagger: 0.1 });
  }

  // e) Brute Force: intentos rápidos + contador -> bloqueo con candado
  function threatBruteForce() {
    const scope = document.querySelector('[data-anim="brute"]');
    if (!scope) return;
    const text = scope.querySelector("#bf-text");
    const count = scope.querySelector("#bf-count");
    const lock = scope.querySelector("#bf-lock");
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#@$";
    const rand = () => Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const state = { n: 0 };

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.7 });
    tl.set(state, { n: 0 })
      .set(lock, { opacity: 0, y: 0 })
      .set(text, { fill: "#FF6B4A" })
      .to(state, {
        n: 248,
        duration: 1.6,
        ease: "power1.in",
        onUpdate() {
          text.textContent = rand();
          count.textContent = "Intentos: " + Math.round(state.n);
        },
      })
      .to(lock, { opacity: 1, y: -3, duration: 0.4, ease: "back.out(2)" })
      .set(text, { fill: "#0EA5A6" })
      .to({}, { duration: 0.6 });
  }

  // f) Spoofing: impostor con misma IP intenta suplantar, EcoSentinel lo marca
  function threatSpoofing() {
    const scope = document.querySelector('[data-anim="spoofing"]');
    if (!scope) return;
    const arrow = scope.querySelector("#sp-arrow");
    const flag = scope.querySelector("#sp-flag");
    const fake = scope.querySelector("#sp-fake circle");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.9 });
    tl.set(arrow, { opacity: 0, attr: { d: "M120 70 L120 70" } })
      .set(flag, { opacity: 0 })
      .to(arrow, { opacity: 1, attr: { d: "M120 70 L95 70" }, duration: 0.6, ease: "power2.out" })
      .to(fake, { stroke: "#FF6B4A", strokeWidth: 3.5, duration: 0.2, repeat: 3, yoyo: true })
      .to(flag, { opacity: 1, duration: 0.4, ease: "back.out(2)" })
      .to({}, { duration: 0.7 })
      .to([arrow, flag], { opacity: 0, duration: 0.4 });
  }

  /* ============================================================
     8. CÓMO FUNCIONA — pipeline con relleno por scroll + flow dot
  ============================================================= */
  function initPipeline() {
    const section = document.getElementById("como-funciona");
    if (!section) return;
    const nodes = gsap.utils.toArray(".pnode");
    const fill = section.querySelector(".pipeline-line .fill");
    const flowDot = section.querySelector(".pipeline-line .flow-dot");
    const isMobile = window.innerWidth <= 768;

    if (REDUCED) {
      nodes.forEach((n) => n.classList.add("active"));
      gsap.set(nodes.map((n) => n.querySelector(".pdesc")), { opacity: 1, y: 0 });
      if (fill) gsap.set(fill, isMobile ? { height: "100%" } : { width: "100%" });
      return;
    }

    // Relleno progresivo de la línea con scrub
    if (fill) {
      gsap.to(fill, {
        [isMobile ? "height" : "width"]: "100%",
        ease: "none",
        scrollTrigger: { trigger: section, start: "top 60%", end: "bottom 70%", scrub: true },
      });
    }

    // Activación secuencial de cada nodo
    nodes.forEach((node, i) => {
      const desc = node.querySelector(".pdesc");
      ScrollTrigger.create({
        trigger: section,
        start: "top 60%",
        end: "bottom 70%",
        onUpdate: (self) => {
          const threshold = i / nodes.length;
          if (self.progress >= threshold) {
            if (!node.classList.contains("active")) {
              node.classList.add("active");
              gsap.to(desc, { opacity: 1, y: 0, duration: 0.4 });
            }
          } else {
            node.classList.remove("active");
            gsap.to(desc, { opacity: 0, y: 8, duration: 0.3 });
          }
        },
      });
    });

    // Punto de datos que viaja infinitamente por el pipeline
    if (flowDot) {
      gsap.set(flowDot, isMobile ? { top: "0%", left: "50%" } : { left: "0%" });
      gsap.to(flowDot, {
        [isMobile ? "top" : "left"]: "100%",
        duration: 2.2,
        ease: "power1.inOut",
        repeat: -1,
      });
    }
  }

  /* ============================================================
     9. MÉTRICAS — anillos circulares, reducción FN y barras comparativas
  ============================================================= */
  function initMetrics() {
    const section = document.getElementById("metricas");
    if (!section) return;

    const rings = gsap.utils.toArray(".ring");
    const R = 52;
    const CIRC = 2 * Math.PI * R;

    rings.forEach((ring) => {
      const bar = ring.querySelector(".bar");
      const valueEl = ring.querySelector(".ring-value");
      const pct = parseFloat(ring.getAttribute("data-ring"));
      const display = ring.getAttribute("data-display");
      gsap.set(bar, { strokeDasharray: CIRC, strokeDashoffset: CIRC });

      if (REDUCED) {
        gsap.set(bar, { strokeDashoffset: CIRC * (1 - pct / 100) });
        valueEl.textContent = display;
        return;
      }

      ScrollTrigger.create({
        trigger: section,
        start: "top 70%",
        once: true,
        onEnter: () => {
          gsap.to(bar, { strokeDashoffset: CIRC * (1 - pct / 100), duration: 1.6, ease: "power2.out" });
          // contador de la etiqueta
          const isDecimal = display.indexOf(".") === 0 || display.startsWith("0.");
          const obj = { v: 0 };
          const targetNum = parseFloat(display);
          gsap.to(obj, {
            v: targetNum,
            duration: 1.6,
            ease: "power2.out",
            snap: { v: isDecimal ? 0.0001 : 0.01 },
            onUpdate() {
              valueEl.textContent = isDecimal
                ? obj.v.toFixed(4)
                : obj.v.toFixed(2) + (display.includes("%") ? "%" : "");
            },
            onComplete() {
              valueEl.textContent = display;
            },
          });
        },
      });
    });

    // Reducción de falsos negativos (número que "cuenta")
    const fn = section.querySelector("[data-fn]");
    if (fn) {
      const target = parseFloat(fn.getAttribute("data-fn"));
      if (REDUCED) {
        fn.textContent = "-" + target + "%";
      } else {
        ScrollTrigger.create({
          trigger: section,
          start: "top 65%",
          once: true,
          onEnter: () => {
            const obj = { v: 0 };
            gsap.to(obj, {
              v: target,
              duration: 1.8,
              ease: "power2.out",
              snap: { v: 0.1 },
              onUpdate() {
                fn.textContent = "-" + obj.v.toFixed(1) + "%";
              },
            });
          },
        });
      }
    }

    // Barras comparativas antes/después
    const bars = gsap.utils.toArray(".bar-inner");
    bars.forEach((bar) => {
      const width = bar.getAttribute("data-width");
      const value = bar.getAttribute("data-value");
      bar.textContent = value;
      if (REDUCED) {
        gsap.set(bar, { width: width + "%" });
        return;
      }
      gsap.set(bar, { width: "0%" });
      ScrollTrigger.create({
        trigger: section,
        start: "top 60%",
        once: true,
        onEnter: () => gsap.to(bar, { width: width + "%", duration: 1.4, ease: "power2.out" }),
      });
    });
  }

  /* ============================================================
     10. PRECIOS — entrada con stagger + hover con GSAP
  ============================================================= */
  function initPricing() {
    const cards = gsap.utils.toArray(".price-card");
    if (!cards.length) return;

    if (!REDUCED) {
      gsap.from(cards, {
        y: 50,
        opacity: 0,
        duration: 0.6,
        ease: "power3.out",
        stagger: 0.12,
        scrollTrigger: { trigger: "#precios", start: "top 75%" },
      });
    }

    cards.forEach((card) => {
      const featured = card.classList.contains("featured");
      const baseScale = featured ? 1.0 : 1.0;
      card.addEventListener("mouseenter", () => {
        if (REDUCED) return;
        gsap.to(card, { y: -10, scale: 1.03, boxShadow: "0 22px 50px rgba(0,0,0,0.35)", duration: 0.3, ease: "power2.out" });
      });
      card.addEventListener("mouseleave", () => {
        if (REDUCED) return;
        gsap.to(card, { y: 0, scale: baseScale, boxShadow: featured ? "var(--shadow-teal)" : "none", duration: 0.3, ease: "power2.out" });
      });
    });
  }

  /* ============================================================
     INIT
  ============================================================= */
  function init() {
    initNavbar();
    initSmoothScroll();
    initHeroText();
    initCounters();
    initHeroParallax();
    initHeroCanvas();
    initThreatCards();
    initPipeline();
    initMetrics();
    initPricing();
    ScrollTrigger.refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
