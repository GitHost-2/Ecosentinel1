/* ============================================================
   EcoSentinel — animations.js (v3.0)
   Implements:
   1. Observer full-screen section transitions (XWzRraJ)
   2. ScrambleText on hero h1 (QWzZwxR)
   3. Horizontal auto-scroll text with char animation (MYyBrZw)
   4. Infinite draggable threat cards (RwKwLWK)
   5. "¿Por qué nosotros?" animated stats + bar chart
   6. Pipeline, counters, navbar
   ============================================================ */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  gsap.registerPlugin(Observer, Draggable);

  /* ============================================================
     UTILS: Manual char splitter (replaces SplitText plugin)
  ============================================================= */
  function splitIntoChars(el) {
    const html = el.innerHTML;
    const chars = [];
    // Walk text nodes only, wrap each character
    function walkNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        const frag = document.createDocumentFragment();
        [...text].forEach((ch) => {
          if (ch === " " || ch === "\u00A0") {
            frag.appendChild(document.createTextNode(" "));
          } else {
            const span = document.createElement("span");
            span.className = "atz-char";
            span.textContent = ch;
            span.style.display = "inline-block";
            span.style.willChange = "transform, opacity";
            frag.appendChild(span);
            chars.push(span);
          }
        });
        node.parentNode.replaceChild(frag, node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        [...node.childNodes].forEach(walkNode);
      }
    }
    [...el.childNodes].forEach(walkNode);
    return chars;
  }

  /* ============================================================
     1. OBSERVER — Full-screen section transitions (XWzRraJ)
  ============================================================= */
  function initObserver() {
    const sections   = document.querySelectorAll(".panel");
    const outerWrappers = gsap.utils.toArray(".panel .outer");
    const innerWrappers = gsap.utils.toArray(".panel .inner");
    const dots       = document.querySelectorAll(".sdot");

    let currentIndex = -1;
    let animating    = false;
    const wrap       = gsap.utils.wrap(0, sections.length);

    // Amenazas-text auto-advance timer
    let atzAutoTimer = null;

    gsap.set(outerWrappers, { yPercent: 100 });
    gsap.set(innerWrappers, { yPercent: -100 });

    function updateDots(index) {
      dots.forEach((d, i) => d.classList.toggle("active", i === index));
    }

    function gotoSection(index, direction) {
      index = wrap(index);
      animating = true;

      const fromTop  = direction === -1;
      const dFactor  = fromTop ? -1 : 1;

      const tl = gsap.timeline({
        defaults: { duration: 1.25, ease: "power1.inOut" },
        onComplete: () => {
          animating = false;
          // If we just entered the amenazas-text section (panel 1), start auto-advance
          if (index === 1) {
            startAtzAutoAdvance();
          }
          // Trigger section-specific enter animation
          onSectionEnter(index, direction);
        },
      });

      if (currentIndex >= 0) {
        gsap.set(sections[currentIndex], { zIndex: 0 });
        tl.to(outerWrappers[currentIndex], { yPercent: -15 * dFactor })
          .set(sections[currentIndex], { autoAlpha: 0 });
      }

      gsap.set(sections[index], { autoAlpha: 1, zIndex: 1 });
      tl.fromTo(
        [outerWrappers[index], innerWrappers[index]],
        { yPercent: (i) => (i ? -100 * dFactor : 100 * dFactor) },
        { yPercent: 0 },
        0
      );

      currentIndex = index;
      updateDots(index);
    }

    // ---- Auto-advance from amenazas-text to amenazas cards ----
    function startAtzAutoAdvance() {
      clearTimeout(atzAutoTimer);
      // Trigger the horizontal text animation, then advance after 4.8s
      triggerAtzTextAnimation(() => {
        if (currentIndex === 1 && !animating) {
          gotoSection(2, 1);
        }
      });
    }

    // ---- Observer: wheel, touch, keyboard ----
    Observer.create({
      type: "wheel,touch,pointer",
      wheelSpeed: -1,
      onDown: () => {
        if (animating) return;
        // Skip auto-advance of atz section when going back
        if (currentIndex === 1) clearTimeout(atzAutoTimer);
        gotoSection(currentIndex - 1, -1);
      },
      onUp: () => {
        if (animating) return;
        // If on amenazas-text (1), let auto-advance handle it — but allow manual skip
        gotoSection(currentIndex + 1, 1);
      },
      tolerance: 10,
      preventDefault: true,
    });

    // Keyboard navigation
    document.addEventListener("keydown", (e) => {
      if (animating) return;
      if (e.key === "ArrowDown" || e.key === "PageDown") gotoSection(currentIndex + 1, 1);
      if (e.key === "ArrowUp"   || e.key === "PageUp")   gotoSection(currentIndex - 1, -1);
    });

    // Nav links and section dot clicks
    document.querySelectorAll("[data-section]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const idx = parseInt(el.getAttribute("data-section"), 10);
        if (!animating && idx !== currentIndex) {
          const dir = idx > currentIndex ? 1 : -1;
          gotoSection(idx, dir);
        }
      });
    });

    // Mobile nav toggle
    const toggle = document.getElementById("navToggle");
    const links  = document.getElementById("navLinks");
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

    // Navbar scroll state — use section index instead of scroll position
    function updateNavbar() {
      const navbar = document.getElementById("navbar");
      if (!navbar) return;
      navbar.classList.toggle("scrolled", currentIndex > 0);
    }
    // Observe index changes via a proxy
    const originalGoto = gotoSection;
    // (navbar updates inside onComplete callback above via onSectionEnter)

    // Start with section 0
    gotoSection(0, 1);

    // Expose for use by other functions
    window._ecoGotoSection = gotoSection;
    window._ecoGetCurrentIndex = () => currentIndex;
  }

  /* ============================================================
     Section-enter callbacks (trigger section-specific animations)
  ============================================================= */
  const sectionInitialized = {};

  function onSectionEnter(index, direction) {
    const navbar = document.getElementById("navbar");
    if (navbar) navbar.classList.toggle("scrolled", index > 0);

    if (sectionInitialized[index]) return;
    sectionInitialized[index] = true;

    switch (index) {
      case 0: initHeroOnEnter(); break;
      case 2: initCardsOnEnter(); break;
      case 3: initPipelineOnEnter(); break;
      case 4: initPorQueOnEnter(); break;
      case 5: initPreciosOnEnter(); break;
    }
  }

  /* ============================================================
     2. HERO CANVAS — Network topology
  ============================================================= */
  function initHeroCanvas() {
    const canvas = document.getElementById("hero-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let w, h, dpr;
    const nodes = [];
    const NODE_COUNT = window.innerWidth < 640 ? 26 : 52;
    const LINK_DIST  = window.innerWidth < 640 ? 120 : 160;
    const TEAL  = "#5EEAD4";
    const CORAL = "#FF6B4A";
    let flashOn = false;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function makeNodes() {
      nodes.length = 0;
      for (let i = 0; i < NODE_COUNT; i++) {
        nodes.push({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
          r: 1.6 + Math.random() * 1.8,
          infected: false, infectT: 0, isolated: false,
        });
      }
    }

    function infectionCycle() {
      if (REDUCED) return;
      const healthy = nodes.filter((n) => !n.infected);
      if (healthy.length) {
        const victim = healthy[Math.floor(Math.random() * healthy.length)];
        victim.infected = true;
        victim.infectT = performance.now();
        gsap.to({ v: 0 }, {
          v: 1, duration: 0.15, repeat: 5, yoyo: true,
          onUpdate() { flashOn = Math.random() > 0.5; },
          onComplete() {
            victim.isolated = true;
            gsap.delayedCall(1.2, () => { victim.infected = false; victim.isolated = false; });
          },
        });
      }
      gsap.delayedCall(2.6 + Math.random() * 1.5, infectionCycle);
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > w) a.vx *= -1;
        if (a.y < 0 || a.y > h) a.vy *= -1;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DIST) {
            if (a.isolated || b.isolated) continue;
            const connectedToInfected = (a.infected && !a.isolated) || (b.infected && !b.isolated);
            const alpha = (1 - dist / LINK_DIST) * 0.5;
            ctx.strokeStyle = connectedToInfected
              ? `rgba(255,107,74,${flashOn ? alpha * 1.6 : alpha * 0.5})`
              : `rgba(94,234,212,${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (const n of nodes) {
        ctx.fillStyle = n.infected ? CORAL : TEAL;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.isolated ? n.r + 1 : n.r, 0, Math.PI * 2); ctx.fill();
        if (n.infected) {
          ctx.strokeStyle = `rgba(255,107,74,${n.isolated ? 0.9 : 0.4})`;
          ctx.lineWidth = n.isolated ? 2 : 1;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2); ctx.stroke();
        }
      }
      requestAnimationFrame(draw);
    }

    resize();
    makeNodes();
    window.addEventListener("resize", () => { resize(); makeNodes(); });
    requestAnimationFrame(draw);
    gsap.delayedCall(1.5, infectionCycle);
  }

  /* ============================================================
     3. HERO ENTER — ScrambleText on h1 (QWzZwxR pattern)
     Manual implementation (ScrambleTextPlugin is premium)
  ============================================================= */
  function initHeroOnEnter() {
    const h1       = document.getElementById("heroTitle");
    const counters = document.querySelectorAll("[data-count]");

    if (!h1 || REDUCED) {
      initCounters(counters);
      return;
    }

    // Store the final HTML to restore the <span class="accent"> at the end
    const finalText   = "Tu red protegida por Inteligencia Artificial";
    const accentStart = finalText.indexOf("Inteligencia");
    const CHARS       = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&?!";

    let frame        = 0;
    const DURATION   = 2.8; // seconds
    const FPS        = 60;
    const totalFrames = DURATION * FPS;
    let rafId;

    // Start scrambled
    h1.textContent = Array.from({ length: finalText.length }, (_, i) =>
      finalText[i] === " " ? " " : CHARS[Math.floor(Math.random() * CHARS.length)]
    ).join("");

    // Fade in h1
    gsap.fromTo(h1, { opacity: 0 }, { opacity: 1, duration: 0.4 });

    function tick() {
      frame++;
      const progress    = frame / totalFrames;
      const revealCount = Math.floor(progress * finalText.length);

      let result = "";
      for (let i = 0; i < finalText.length; i++) {
        if (finalText[i] === " ") {
          result += " ";
        } else if (i < revealCount) {
          result += finalText[i];
        } else {
          result += CHARS[Math.floor(Math.random() * CHARS.length)];
        }
      }
      h1.textContent = result;

      if (frame < totalFrames) {
        rafId = requestAnimationFrame(tick);
      } else {
        // Restore HTML with accent span
        h1.innerHTML =
          'Tu red protegida por <span class="accent">Inteligencia Artificial</span>';
        // Animate hero sub-elements in
        gsap.from(".hero-badge", { opacity: 0, y: -12, duration: 0.5, delay: 0.1 });
        gsap.from(".hero-sub",   { opacity: 0, y: 16, duration: 0.6, delay: 0.2 });
        gsap.from(".hero-cta",   { opacity: 0, y: 16, duration: 0.6, delay: 0.35 });
        gsap.from(".hero-metrics .metric", {
          opacity: 0, y: 20, duration: 0.5, stagger: 0.1, delay: 0.5,
        });
        // Start counters
        initCounters(counters);
      }
    }

    // Slight delay before scramble starts
    setTimeout(() => { rafId = requestAnimationFrame(tick); }, 300);
  }

  /* ============================================================
     4. COUNTERS (hero metrics)
  ============================================================= */
  function initCounters(els) {
    if (!els) return;
    els.forEach((el) => {
      const target   = parseFloat(el.getAttribute("data-count"));
      const decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
      const prefix   = (el.getAttribute("data-prefix") || "").replace("&lt;", "<");
      const suffix   = el.getAttribute("data-suffix") || "";
      const snapInc  = decimals > 0 ? parseFloat("0." + "0".repeat(decimals - 1) + "1") : 1;
      const obj      = { val: 0 };

      if (REDUCED) { obj.val = target; el.textContent = prefix + obj.val.toFixed(decimals) + suffix; return; }

      gsap.to(obj, {
        val: target, duration: 2, ease: "power2.out", delay: 0.8,
        snap: { val: snapInc },
        onUpdate: () => { el.textContent = prefix + obj.val.toFixed(decimals) + suffix; },
      });
    });
  }

  /* ============================================================
     5. AMENAZAS TEXT — Horizontal auto-scroll + char animation
        Inspired by MYyBrZw (containerAnimation SplitText)
  ============================================================= */
  let atzTimeline = null;

  function triggerAtzTextAnimation(onComplete) {
    const section = document.getElementById("amenazas-text");
    const textEl  = document.getElementById("atzText");
    if (!section || !textEl) { onComplete && onComplete(); return; }

    if (REDUCED) { onComplete && onComplete(); return; }

    // Split chars on first run
    let chars = textEl.querySelectorAll(".atz-char");
    if (chars.length === 0) {
      chars = splitIntoChars(textEl);
    }

    // Kill any previous run
    if (atzTimeline) { atzTimeline.kill(); }

    // Reset text position
    gsap.set(textEl, { x: 0 });
    gsap.set(chars,  { yPercent: 0, rotation: 0, opacity: 1 });

    // Build the timeline (MYyBrZw spirit):
    // Text scrolls from right → left; chars fly in from random yPercent
    const textWidth = textEl.scrollWidth;
    const vw        = window.innerWidth;

    atzTimeline = gsap.timeline({ onComplete });

    // Move the whole text from off-screen right to off-screen left
    atzTimeline.fromTo(
      textEl,
      { x: vw },
      { x: -textWidth, duration: 4.5, ease: "none" }
    );

    // Each char flies in from a random vertical offset as its
    // position sweeps through the viewport
    chars.forEach((char, i) => {
      const progress = i / chars.length; // 0 → 1
      const startTime = progress * 3.5;   // staggered across the scroll duration
      atzTimeline.fromTo(
        char,
        {
          yPercent: () => gsap.utils.random(-250, 250),
          rotation: () => gsap.utils.random(-25, 25),
          opacity: 0,
        },
        {
          yPercent: 0,
          rotation: 0,
          opacity: 1,
          duration: 0.65,
          ease: "back.out(1.2)",
        },
        startTime
      );
    });
  }

  /* ============================================================
     6. THREAT CARDS — Infinite draggable carousel (RwKwLWK)
  ============================================================= */
  function initCardsOnEnter() {
    const deck = document.getElementById("threatCardsDeck");
    if (!deck) return;

    const cards   = gsap.utils.toArray(".cards-deck .threat-card");
    if (!cards.length) return;

    const spacing  = 0.15;
    const snapTime = gsap.utils.snap(spacing);

    const animateFunc = (el) => {
      const tl = gsap.timeline();
      tl.fromTo(el,
        { scale: 0, opacity: 0 },
        { scale: 1, opacity: 1, zIndex: 100, duration: 0.5, yoyo: true, repeat: 1, ease: "power1.in", immediateRender: false }
      ).fromTo(el,
        { xPercent: 400 },
        { xPercent: -400, duration: 1, ease: "none", immediateRender: false },
        0
      );
      return tl;
    };

    const seamlessLoop  = buildSeamlessLoop(cards, spacing, animateFunc);
    const wrapTime      = gsap.utils.wrap(0, seamlessLoop.duration());
    const playhead      = { offset: 0 };

    const scrub = gsap.to(playhead, {
      offset: 0,
      onUpdate() { seamlessLoop.time(wrapTime(playhead.offset)); },
      duration: 0.5,
      ease: "power3",
      paused: true,
    });

    const counterEl = document.getElementById("cardsCurrentNum");

    function scrollToOffset(offset) {
      const snapped   = snapTime(offset);
      const totalDur  = seamlessLoop.duration();
      const progress  = ((snapped % totalDur) + totalDur) % totalDur / totalDur;
      const cardIndex = Math.round(progress * cards.length) % cards.length;
      if (counterEl) counterEl.textContent = cardIndex + 1;

      scrub.vars.offset = snapped;
      scrub.invalidate().restart();
    }

    // Buttons
    const nextBtn = document.getElementById("cardsNext");
    const prevBtn = document.getElementById("cardsPrev");
    if (nextBtn) nextBtn.addEventListener("click", () => scrollToOffset(playhead.offset + spacing));
    if (prevBtn) prevBtn.addEventListener("click", () => scrollToOffset(playhead.offset - spacing));

    // Draggable for touch/mouse
    Draggable.create(".drag-proxy", {
      type: "x",
      trigger: ".cards-deck",
      onPress() { this.startOffset = playhead.offset; },
      onDrag() {
        scrub.vars.offset = this.startOffset + (this.startX - this.x) * 0.0015;
        scrub.invalidate().restart();
      },
      onDragEnd() { scrollToOffset(scrub.vars.offset); },
    });

    // Also init threat SVG animations while cards are visible
    if (!REDUCED) {
      threatRansomware();
      threatDDoS();
      threatPortScan();
      threatBotnet();
      threatBruteForce();
      threatSpoofing();
    }
  }

  /* buildSeamlessLoop — verbatim from RwKwLWK CodePen */
  function buildSeamlessLoop(items, spacing, animateFunc) {
    const overlap     = Math.ceil(1 / spacing);
    const startTime   = items.length * spacing + 0.5;
    const loopTime    = (items.length + overlap) * spacing + 1;
    const rawSequence = gsap.timeline({ paused: true });
    const seamlessLoop= gsap.timeline({
      paused: true,
      repeat: -1,
      onRepeat() { this._time === this._dur && (this._tTime += this._dur - 0.01); },
    });
    const l = items.length + overlap * 2;

    for (let i = 0; i < l; i++) {
      const index = i % items.length;
      const time  = i * spacing;
      rawSequence.add(animateFunc(items[index]), time);
    }

    rawSequence.time(startTime);
    seamlessLoop
      .to(rawSequence, { time: loopTime, duration: loopTime - startTime, ease: "none" })
      .fromTo(rawSequence,
        { time: overlap * spacing + 1 },
        { time: startTime, duration: startTime - (overlap * spacing + 1), immediateRender: false, ease: "none" }
      );
    return seamlessLoop;
  }

  /* ============================================================
     7. PIPELINE — Como funciona section
  ============================================================= */
  function initPipelineOnEnter() {
    const section  = document.getElementById("como-funciona");
    if (!section) return;
    const nodes    = gsap.utils.toArray(".pnode");
    const fill     = section.querySelector(".pipeline-line .fill");
    const flowDot  = section.querySelector(".pipeline-line .flow-dot");
    const isMobile = window.innerWidth <= 768;

    if (REDUCED) {
      nodes.forEach((n) => n.classList.add("active"));
      gsap.set(nodes.map((n) => n.querySelector(".pdesc")), { opacity: 1, y: 0 });
      if (fill) gsap.set(fill, isMobile ? { height: "100%" } : { width: "100%" });
      return;
    }

    // Animate section title chars
    const h2 = section.querySelector(".section-head h2");
    if (h2) {
      gsap.from(h2, { opacity: 0, y: 30, duration: 0.7, ease: "power2.out" });
    }

    // Fill the pipeline line
    if (fill) {
      gsap.to(fill, {
        [isMobile ? "height" : "width"]: "100%",
        duration: nodes.length * 0.4,
        ease: "none",
        delay: 0.3,
      });
    }

    // Activate nodes one by one
    nodes.forEach((node, i) => {
      const desc = node.querySelector(".pdesc");
      gsap.delayedCall(0.3 + i * 0.4, () => {
        node.classList.add("active");
        gsap.to(desc, { opacity: 1, y: 0, duration: 0.4 });
      });
    });

    if (flowDot) {
      gsap.set(flowDot, isMobile ? { top: "0%", left: "50%" } : { left: "0%" });
      gsap.to(flowDot, {
        [isMobile ? "top" : "left"]: "100%",
        duration: 2.2, ease: "power1.inOut", repeat: -1,
      });
    }
  }

  /* ============================================================
     8. POR QUÉ NOSOTROS — Animated stats + bar chart
  ============================================================= */
  function initPorQueOnEnter() {
    const section = document.getElementById("por-que-nosotros");
    if (!section || REDUCED) return;

    // Animate section head
    const h2 = section.querySelector(".section-head h2");
    if (h2) {
      gsap.from(h2, { opacity: 0, y: 30, duration: 0.7, ease: "power2.out" });
    }

    // Stat cards fly in
    const stats = gsap.utils.toArray(".pq-stat");
    gsap.from(stats, {
      opacity: 0, y: 40, duration: 0.6, ease: "power3.out",
      stagger: 0.1, delay: 0.2,
    });

    // Animated counters for stat values
    section.querySelectorAll("[data-pq-count]").forEach((el) => {
      const target   = parseFloat(el.getAttribute("data-pq-count"));
      const decimals = parseInt(el.getAttribute("data-pq-decimals") || "0", 10);
      const prefix   = el.getAttribute("data-pq-prefix") || "";
      const suffix   = el.getAttribute("data-pq-suffix") || "";
      const obj      = { val: 0 };

      gsap.to(obj, {
        val: target,
        duration: 2,
        ease: "power2.out",
        delay: 0.4,
        snap: { val: decimals > 0 ? 0.01 : 1 },
        onUpdate: () => { el.textContent = prefix + obj.val.toFixed(decimals) + suffix; },
      });
    });

    // Bar chart animation
    const bars = gsap.utils.toArray(".pq-bar-fill");
    gsap.from(section.querySelector(".pq-chart-wrap"), {
      opacity: 0, y: 30, duration: 0.6, ease: "power2.out", delay: 0.5,
    });

    bars.forEach((bar, i) => {
      const targetH = bar.getAttribute("data-height") + "%";
      gsap.to(bar, {
        height: targetH,
        duration: 0.8,
        ease: "power2.out",
        delay: 0.7 + i * 0.08,
      });
    });
  }

  /* ============================================================
     9. PRECIOS CARDS — fly-in on enter
  ============================================================= */
  function initPreciosOnEnter() {
    const cards = gsap.utils.toArray(".price-card");
    if (!REDUCED && cards.length) {
      gsap.from(cards, {
        y: 80, opacity: 0, duration: 0.8, ease: "power3.out",
        stagger: 0.18, delay: 0.1,
      });
    }
    const h2 = document.querySelector("#precios .section-head h2");
    if (h2) {
      gsap.from(h2, { opacity: 0, y: 30, duration: 0.7, ease: "power2.out" });
    }
  }

  /* ============================================================
     10. THREAT CARD SVG ANIMATIONS
  ============================================================= */
  function threatRansomware() {
    const scope = document.querySelector('[data-anim="ransomware"]');
    if (!scope) return;
    const lines = scope.querySelectorAll("#rw-lines line");
    const lock  = scope.querySelector("#rw-lock");
    const tl    = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
    tl.to(lines, { stroke: "#FF6B4A", duration: 0.3, stagger: 0.12 })
      .to(lines, { attr: { x2: (i, t) => 80 + Math.random() * 40 }, duration: 0.2, repeat: 3, yoyo: true }, "<")
      .to(lock,  { opacity: 1, y: -4, duration: 0.4, ease: "back.out(2)" })
      .to({},    { duration: 0.6 })
      .to(lock,  { opacity: 0, duration: 0.4 })
      .to(lines, { stroke: "#5EEAD4", attr: { x2: (i) => (i === 2 ? 108 : 120) }, duration: 0.4 });
  }

  function threatDDoS() {
    const scope   = document.querySelector('[data-anim="ddos"]');
    if (!scope) return;
    const packets = scope.querySelectorAll(".pk");
    const server  = scope.querySelector("#ddos-server");
    const shield  = scope.querySelector("#ddos-shield");
    const home    = [];
    packets.forEach((p) => home.push({ x: p.getAttribute("cx"), y: p.getAttribute("cy") }));
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    tl.to(packets, { attr: { cx: 100, cy: 75 }, duration: 0.7, ease: "power1.in", stagger: 0.05 })
      .to(server,  { stroke: "#FF6B4A", duration: 0.15, repeat: 3, yoyo: true }, "<0.3")
      .set(shield, { opacity: 1, scale: 0.6, transformOrigin: "100px 75px" })
      .to(shield,  { scale: 1, duration: 0.3, ease: "back.out(2)" })
      .to(packets, { attr: { cx: (i) => home[i].x, cy: (i) => home[i].y }, duration: 0.6, ease: "power2.out" })
      .to(shield,  { opacity: 0, duration: 0.3 })
      .to(server,  { stroke: "#5EEAD4", duration: 0.2 }, "<");
  }

  function threatPortScan() {
    const scope   = document.querySelector('[data-anim="portscan"]');
    if (!scope) return;
    const scanner = scope.querySelector("#ps-scanner");
    const ports   = scope.querySelectorAll(".port rect");
    const xs = [41, 83, 125, 167];
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.7 });
    xs.forEach((x, i) => {
      tl.to(scanner, { attr: { x1: x, x2: x }, duration: 0.35, ease: "power1.inOut" })
        .to(ports[i], { stroke: "#FF6B4A", duration: 0.15 }, "<0.1");
    });
    tl.to(scanner, { stroke: "#0EA5A6", duration: 0.2 })
      .to(ports,   { stroke: "#5EEAD4", duration: 0.4, stagger: 0.05 })
      .to(scanner, { stroke: "#FF6B4A", duration: 0.2 });
  }

  function threatBotnet() {
    const scope   = document.querySelector('[data-anim="botnet"]');
    if (!scope) return;
    const devices = scope.querySelectorAll(".bn-device rect");
    const links   = scope.querySelector("#bn-links");
    const cnc     = scope.querySelector("#bn-cnc");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
    tl.to(devices, { stroke: "#FF6B4A", duration: 0.3, stagger: 0.25 })
      .to(links,   { opacity: 1, duration: 0.3 }, "<0.2")
      .to(cnc,     { stroke: "#FF6B4A", scale: 1.1, transformOrigin: "100px 125px", duration: 0.2, repeat: 2, yoyo: true })
      .to({},      { duration: 0.4 })
      .to(links,   { opacity: 0, duration: 0.3 })
      .to(devices, { stroke: "#5EEAD4", duration: 0.4, stagger: 0.1 });
  }

  function threatBruteForce() {
    const scope = document.querySelector('[data-anim="brute"]');
    if (!scope) return;
    const text  = scope.querySelector("#bf-text");
    const count = scope.querySelector("#bf-count");
    const lock  = scope.querySelector("#bf-lock");
    const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#@$";
    const rand  = () => Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
    const state = { n: 0 };
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.7 });
    tl.set(state, { n: 0 }).set(lock, { opacity: 0, y: 0 }).set(text, { fill: "#FF6B4A" })
      .to(state, {
        n: 248, duration: 1.6, ease: "power1.in",
        onUpdate() { text.textContent = rand(); count.textContent = "Intentos: " + Math.round(state.n); },
      })
      .to(lock,  { opacity: 1, y: -3, duration: 0.4, ease: "back.out(2)" })
      .set(text, { fill: "#0EA5A6" })
      .to({},    { duration: 0.6 });
  }

  function threatSpoofing() {
    const scope = document.querySelector('[data-anim="spoofing"]');
    if (!scope) return;
    const arrow = scope.querySelector("#sp-arrow");
    const flag  = scope.querySelector("#sp-flag");
    const fake  = scope.querySelector("#sp-fake circle");
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.9 });
    tl.set(arrow, { opacity: 0, attr: { d: "M120 70 L120 70" } })
      .set(flag,  { opacity: 0 })
      .to(arrow,  { opacity: 1, attr: { d: "M120 70 L95 70" }, duration: 0.6, ease: "power2.out" })
      .to(fake,   { stroke: "#FF6B4A", strokeWidth: 3.5, duration: 0.2, repeat: 3, yoyo: true })
      .to(flag,   { opacity: 1, duration: 0.4, ease: "back.out(2)" })
      .to({},     { duration: 0.7 })
      .to([arrow, flag], { opacity: 0, duration: 0.4 });
  }

  /* ============================================================
     INIT
  ============================================================= */
  function init() {
    initHeroCanvas();
    initObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
