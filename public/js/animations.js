/* ============================================================
   EcoSentinel — animations.js
   GSAP: navbar, texto cifrado/descifrado en todos los títulos,
   crawl horizontal de "Seis vectores..." con fondo de red
   neuronal roja, carrusel de amenazas, pipeline,
   "¿Por qué nosotros?" y precios.
   ============================================================ */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, SplitText, ScrambleTextPlugin);

  /* ============================================================
     1. NAVBAR — transición transparente -> sólida con ScrollTrigger
  ============================================================= */
  function initNavbar() {
    const navbar = document.getElementById("navbar");
    if (!navbar) return;

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
     2. SMOOTH SCROLL — links de navegación
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
     3. TEXTO CIFRADO/DESCIFRADO (ScrambleTextPlugin)
        Se usa en el título del hero y en todos los títulos de
        sección: primero se ve el texto "encriptado" (revuelto) y
        luego se descifra letra por letra, despacio y de forma
        notoria (nada de instantáneo).
  ============================================================= */
  function scrambleReveal(el, fullText, opts) {
    opts = opts || {};
    if (REDUCED) {
      el.textContent = fullText;
      if (opts.onComplete) opts.onComplete();
      return;
    }
    el.textContent = "";
    gsap.to(el, {
      duration: opts.duration || 3.4,
      delay: opts.delay || 0.15,
      ease: "power1.inOut",
      scrambleText: {
        text: fullText,
        chars: "upperAndLowerCase",
        revealDelay: opts.revealDelay || 0.55,
        tweenLength: true,
      },
      onComplete: opts.onComplete,
    });
  }

  function initHeroScramble() {
    const el = document.getElementById("heroTitle");
    if (!el) return;
    const fullText = el.getAttribute("data-full-text") || el.textContent.trim();
    const accentText = el.getAttribute("data-accent") || "";

    function applyAccent() {
      el.textContent = fullText;
      if (!accentText) return;
      const idx = fullText.indexOf(accentText);
      if (idx === -1) return;
      const before = fullText.slice(0, idx);
      const after = fullText.slice(idx + accentText.length);
      el.textContent = "";
      el.append(document.createTextNode(before));
      const span = document.createElement("span");
      span.className = "accent";
      span.textContent = accentText;
      el.appendChild(span);
      el.append(document.createTextNode(after));
    }

    scrambleReveal(el, fullText, { duration: 3.6, delay: 0.3, revealDelay: 0.6, onComplete: applyAccent });
  }

  // Resto de títulos de sección (marcados con [data-scramble]): se
  // descifran al entrar en la vista, una sola vez.
  function initSectionScrambles() {
    document.querySelectorAll("[data-scramble]").forEach((el) => {
      const fullText = el.textContent.trim();
      const run = () => scrambleReveal(el, fullText);
      if (REDUCED) {
        run();
        return;
      }
      ScrollTrigger.create({
        trigger: el,
        start: "top 82%",
        once: true,
        onEnter: run,
      });
    });
  }

  /* ============================================================
     4. HERO — contadores animados desde 0 con snap
  ============================================================= */
  function formatCount(val, decimals, prefix, suffix) {
    const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    return prefix + val.toLocaleString("es-MX", opts) + suffix;
  }

  function initCounters() {
    document.querySelectorAll("[data-count]").forEach((el) => {
      const target = parseFloat(el.getAttribute("data-count"));
      const decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
      const prefix = (el.getAttribute("data-prefix") || "").replace("&lt;", "<");
      const suffix = el.getAttribute("data-suffix") || "";
      const snapInc = decimals > 0 ? parseFloat("0." + "0".repeat(decimals - 1) + "1") : 1;
      const obj = { val: 0 };

      const render = () => {
        el.textContent = formatCount(obj.val, decimals, prefix, suffix);
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
    const TEAL = "#6FBDB0";
    const CORAL = "#C4694A";

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

    let flashOn = false;
    function infectionCycle() {
      if (REDUCED) return;
      const healthy = nodes.filter((n) => !n.infected);
      if (healthy.length) {
        const victim = healthy[Math.floor(Math.random() * healthy.length)];
        victim.infected = true;
        victim.infectT = performance.now();
        gsap.to({ v: 0 }, {
          v: 1,
          duration: 0.15,
          repeat: 5,
          yoyo: true,
          onUpdate() {
            flashOn = Math.random() > 0.5;
          },
          onComplete() {
            victim.isolated = true;
            gsap.delayedCall(1.2, () => {
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
            if (a.isolated || b.isolated) continue;
            ctx.strokeStyle = connectedToInfected
              ? `rgba(196,105,74,${flashOn ? alpha * 1.6 : alpha * 0.5})`
              : `rgba(111,189,176,${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      for (const n of nodes) {
        let color = TEAL;
        if (n.infected) color = CORAL;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.isolated ? n.r + 1 : n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.infected) {
          ctx.strokeStyle = `rgba(196,105,74,${n.isolated ? 0.9 : 0.4})`;
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
     7. AMENAZAS — fondo de red neuronal roja con calaveras
  ============================================================= */
  function initAmenazasCanvas() {
    const canvas = document.getElementById("amenazasCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let w, h, dpr;
    const nodes = [];
    const NODE_COUNT = window.innerWidth < 640 ? 20 : 40;
    const LINK_DIST = window.innerWidth < 640 ? 110 : 150;
    const RED = "#e0504f";
    const RED_RGB = "196,40,40";

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
          vx: (Math.random() - 0.5) * 0.24,
          vy: (Math.random() - 0.5) * 0.24,
          r: 1.6 + Math.random() * 1.8,
          skull: Math.random() < 0.14,
        });
      }
    }

    function paint() {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DIST) {
            const alpha = (1 - dist / LINK_DIST) * 0.4;
            ctx.strokeStyle = `rgba(${RED_RGB},${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      for (const n of nodes) {
        if (n.skull) {
          ctx.font = "18px serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.globalAlpha = 0.8;
          ctx.fillText("💀", n.x, n.y);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = RED;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function draw() {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
      }
      paint();
      requestAnimationFrame(draw);
    }

    resize();
    makeNodes();
    window.addEventListener("resize", () => {
      resize();
      makeNodes();
      if (REDUCED) paint();
    });

    paint();
    if (!REDUCED) requestAnimationFrame(draw);
  }

  /* ============================================================
     8. AMENAZAS — titular "Seis vectores de ataque, un solo
        guardián" en crawl horizontal fijado con scroll (pin +
        SplitText vía containerAnimation). En pantallas angostas,
        donde no hay espacio para un crawl, se revela con el mismo
        efecto de cifrado/descifrado que el resto de los títulos.
  ============================================================= */
  function initAmenazasHeading() {
    const wrapper = document.querySelector(".amenazas-heading-panel");
    const text = document.getElementById("amenazasHeading");
    if (!wrapper || !text) return;

    if (REDUCED) return;

    if (window.innerWidth < 700) {
      const fullText = text.textContent.trim();
      ScrollTrigger.create({
        trigger: wrapper,
        start: "top 75%",
        once: true,
        onEnter: () => scrambleReveal(text, fullText),
      });
      return;
    }

    const split = new SplitText(text, { type: "chars, words" });

    const scrollTween = gsap.to(text, {
      xPercent: -100,
      ease: "none",
      scrollTrigger: {
        trigger: wrapper,
        pin: true,
        end: "+=3500",
        scrub: true,
      },
    });

    split.chars.forEach((char) => {
      gsap.from(char, {
        yPercent: () => gsap.utils.random(-200, 200),
        rotation: () => gsap.utils.random(-20, 20),
        autoAlpha: 0,
        ease: "back.out(1.2)",
        scrollTrigger: {
          trigger: char,
          containerAnimation: scrollTween,
          start: "left 100%",
          end: "left 30%",
          scrub: 1,
        },
      });
    });
  }

  /* ============================================================
     9. AMENAZAS — mini animaciones SVG por tarjeta (loops)
  ============================================================= */
  function threatRansomware() {
    const scope = document.querySelector('[data-anim="ransomware"]');
    if (!scope) return;
    const lines = scope.querySelectorAll("#rw-lines line");
    const lock = scope.querySelector("#rw-lock");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
    tl.to(lines, { stroke: "#C4694A", duration: 0.3, stagger: 0.12 })
      .to(lines, { attr: { x2: () => 80 + Math.random() * 40 }, duration: 0.2, repeat: 3, yoyo: true }, "<")
      .to(lock, { opacity: 1, y: -4, duration: 0.4, ease: "back.out(2)" })
      .to({}, { duration: 0.6 })
      .to(lock, { opacity: 0, duration: 0.4 })
      .to(lines, { stroke: "#6FBDB0", attr: { x2: (i) => (i === 2 ? 108 : 120) }, duration: 0.4 });
  }

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
      .to(server, { stroke: "#C4694A", duration: 0.15, repeat: 3, yoyo: true }, "<0.3")
      .set(shield, { opacity: 1, scale: 0.6, transformOrigin: "100px 75px" })
      .to(shield, { scale: 1, duration: 0.3, ease: "back.out(2)" })
      .to(packets, {
        attr: { cx: (i) => home[i].x, cy: (i) => home[i].y },
        duration: 0.6,
        ease: "power2.out",
      })
      .to(shield, { opacity: 0, duration: 0.3 })
      .to(server, { stroke: "#6FBDB0", duration: 0.2 }, "<");
  }

  function threatPortScan() {
    const scope = document.querySelector('[data-anim="portscan"]');
    if (!scope) return;
    const scanner = scope.querySelector("#ps-scanner");
    const ports = scope.querySelectorAll(".port rect");
    const xs = [41, 83, 125, 167];
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.7 });
    xs.forEach((x, i) => {
      tl.to(scanner, { attr: { x1: x, x2: x }, duration: 0.35, ease: "power1.inOut" })
        .to(ports[i], { stroke: "#C4694A", duration: 0.15 }, "<0.1");
    });
    tl.to(scanner, { stroke: "#2F8F86", duration: 0.2 })
      .to(ports, { stroke: "#6FBDB0", duration: 0.4, stagger: 0.05 })
      .to(scanner, { stroke: "#C4694A", duration: 0.2 });
  }

  function threatBotnet() {
    const scope = document.querySelector('[data-anim="botnet"]');
    if (!scope) return;
    const devices = scope.querySelectorAll(".bn-device rect");
    const links = scope.querySelector("#bn-links");
    const cnc = scope.querySelector("#bn-cnc");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
    tl.to(devices, { stroke: "#C4694A", duration: 0.3, stagger: 0.25 })
      .to(links, { opacity: 1, duration: 0.3 }, "<0.2")
      .to(cnc, { stroke: "#C4694A", scale: 1.1, transformOrigin: "100px 125px", duration: 0.2, repeat: 2, yoyo: true })
      .to({}, { duration: 0.4 })
      .to(links, { opacity: 0, duration: 0.3 })
      .to(devices, { stroke: "#6FBDB0", duration: 0.4, stagger: 0.1 });
  }

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
      .set(text, { fill: "#C4694A" })
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
      .set(text, { fill: "#2F8F86" })
      .to({}, { duration: 0.6 });
  }

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
      .to(fake, { stroke: "#C4694A", strokeWidth: 3.5, duration: 0.2, repeat: 3, yoyo: true })
      .to(flag, { opacity: 1, duration: 0.4, ease: "back.out(2)" })
      .to({}, { duration: 0.7 })
      .to([arrow, flag], { opacity: 0, duration: 0.4 });
  }

  function initThreatMiniLoops() {
    if (REDUCED) return;
    threatRansomware();
    threatDDoS();
    threatPortScan();
    threatBotnet();
    threatBruteForce();
    threatSpoofing();
  }

  /* ============================================================
     10. AMENAZAS — carrusel de tarjetas en bucle continuo
        (adaptado de "CARTAS DE AMENAZAS": loop sin costuras;
        estático, solo avanza con Siguiente/Anterior o al tocar
        una tarjeta)
  ============================================================= */
  function buildSeamlessLoop(items, spacing, animateFunc) {
    let overlap = Math.ceil(1 / spacing),
      startTime = items.length * spacing + 0.5,
      loopTime = (items.length + overlap) * spacing + 1,
      rawSequence = gsap.timeline({ paused: true }),
      seamlessLoop = gsap.timeline({
        paused: true,
        repeat: -1,
        onRepeat() {
          this._time === this._dur && (this._tTime += this._dur - 0.01);
        },
      }),
      l = items.length + overlap * 2,
      time,
      i,
      index;

    for (i = 0; i < l; i++) {
      index = i % items.length;
      time = i * spacing;
      rawSequence.add(animateFunc(items[index]), time);
      i <= items.length && seamlessLoop.add("label" + i, time);
    }

    rawSequence.time(startTime);
    seamlessLoop
      .to(rawSequence, { time: loopTime, duration: loopTime - startTime, ease: "none" })
      .fromTo(
        rawSequence,
        { time: overlap * spacing + 1 },
        { time: startTime, duration: startTime - (overlap * spacing + 1), immediateRender: false, ease: "none" }
      );
    return seamlessLoop;
  }

  function buildCardsCarousel() {
    const cardsList = document.querySelector(".cards");
    const cards = gsap.utils.toArray(".cards li.threat-card");
    if (!cards.length) return;

    if (REDUCED) {
      if (cardsList) cardsList.classList.add("static-grid");
      gsap.set(cards, { clearProps: "all" });
      return;
    }

    gsap.set(cards, { xPercent: 400, opacity: 0, scale: 0 });

    const spacing = 0.15;
    const animateFunc = (element) => {
      const tl = gsap.timeline();
      tl.fromTo(
        element,
        { scale: 0, opacity: 0 },
        { scale: 1, opacity: 1, zIndex: 100, duration: 0.5, yoyo: true, repeat: 1, ease: "power1.in", immediateRender: false }
      ).fromTo(element, { xPercent: 400 }, { xPercent: -400, duration: 1, ease: "none", immediateRender: false }, 0);
      return tl;
    };

    const seamlessLoop = buildSeamlessLoop(cards, spacing, animateFunc);
    const playhead = { offset: 0 };
    const wrapTime = gsap.utils.wrap(0, seamlessLoop.duration());

    const scrub = gsap.to(playhead, {
      offset: 0,
      onUpdate() {
        seamlessLoop.time(wrapTime(playhead.offset));
      },
      duration: 0.6,
      ease: "power2.out",
      paused: true,
    });

    function goTo(steps) {
      scrub.vars.offset += steps * spacing;
      scrub.invalidate().restart();
    }

    document.getElementById("cardsNext")?.addEventListener("click", () => goTo(1));
    document.getElementById("cardsPrev")?.addEventListener("click", () => goTo(-1));
    cards.forEach((card) => {
      card.addEventListener("click", () => goTo(1));
    });
  }

  /* ============================================================
     11. CÓMO FUNCIONA — pipeline con relleno por scroll + flow dot
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

    if (fill) {
      gsap.to(fill, {
        [isMobile ? "height" : "width"]: "100%",
        ease: "none",
        scrollTrigger: { trigger: section, start: "top 60%", end: "bottom 70%", scrub: true },
      });
    }

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
     12. ¿POR QUÉ NOSOTROS? — estadísticas reales de ciberataques
  ============================================================= */
  function initWhyUs() {
    const section = document.getElementById("porque-nosotros");
    if (!section) return;

    function animateCount(el) {
      const target = parseFloat(el.getAttribute("data-count"));
      const decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
      const suffix = el.getAttribute("data-suffix") || "";
      const prefix = el.getAttribute("data-prefix") || "";
      if (REDUCED) {
        el.textContent = formatCount(target, decimals, prefix, suffix);
        return;
      }
      const obj = { v: 0 };
      gsap.to(obj, {
        v: target,
        duration: 1.8,
        ease: "power2.out",
        onUpdate() {
          el.textContent = formatCount(obj.v, decimals, prefix, suffix);
        },
        onComplete() {
          el.textContent = formatCount(target, decimals, prefix, suffix);
        },
      });
    }

    function animateGrowth() {
      const el = section.querySelector("[data-growth]");
      if (!el) return;
      const target = parseFloat(el.getAttribute("data-growth"));
      if (REDUCED) {
        el.textContent = "+" + target + "%";
        return;
      }
      const obj = { v: 0 };
      gsap.to(obj, {
        v: target,
        duration: 1.8,
        ease: "power2.out",
        snap: { v: 1 },
        onUpdate() {
          el.textContent = "+" + Math.round(obj.v) + "%";
        },
      });
    }

    function animateBars() {
      section.querySelectorAll(".bar-inner").forEach((bar) => {
        const width = bar.getAttribute("data-width");
        const value = bar.getAttribute("data-value");
        bar.textContent = value;
        if (REDUCED) {
          gsap.set(bar, { width: width + "%" });
          return;
        }
        gsap.set(bar, { width: "0%" });
        gsap.to(bar, { width: width + "%", duration: 1.4, ease: "power2.out", delay: 0.2 });
      });
    }

    function playReveal() {
      section.querySelectorAll(".why-value").forEach(animateCount);
      animateGrowth();
      animateBars();
    }

    if (REDUCED) {
      playReveal();
      return;
    }

    ScrollTrigger.create({
      trigger: section,
      start: "top 70%",
      once: true,
      onEnter: playReveal,
    });

    gsap.from(section.querySelectorAll(".why-stat"), {
      y: 40,
      opacity: 0,
      duration: 0.6,
      ease: "power3.out",
      stagger: 0.1,
      scrollTrigger: { trigger: section, start: "top 75%" },
    });
  }

  /* ============================================================
     13. PRECIOS — entrada con stagger + hover con GSAP
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
      card.addEventListener("mouseenter", () => {
        if (REDUCED) return;
        gsap.to(card, { y: -10, scale: 1.03, boxShadow: "0 22px 50px rgba(0,0,0,0.5)", duration: 0.3, ease: "power2.out" });
      });
      card.addEventListener("mouseleave", () => {
        if (REDUCED) return;
        gsap.to(card, { y: 0, scale: 1, boxShadow: featured ? "var(--shadow-teal)" : "none", duration: 0.3, ease: "power2.out" });
      });
    });
  }

  /* ============================================================
     INIT
  ============================================================= */
  function init() {
    initNavbar();
    initHeroScramble();
    initSectionScrambles();
    initCounters();
    initHeroCanvas();
    initHeroParallax();
    initAmenazasCanvas();
    initAmenazasHeading();
    initThreatMiniLoops();
    buildCardsCarousel();
    initPipeline();
    initWhyUs();
    initPricing();
    initSmoothScroll();
    ScrollTrigger.refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
