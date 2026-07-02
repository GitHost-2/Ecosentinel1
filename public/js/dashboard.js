/* ============================================================
   EcoSentinel — dashboard.js
   Panel de monitoreo con datos SIMULADOS.
   Cuando se conecte al appliance real, los datos llegarán vía
   WebSocket desde el motor de inferencia. La función connectLive()
   deja preparado ese punto de integración.
   ============================================================ */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Sesión ---------- */
  function loadSession() {
    try {
      const raw = sessionStorage.getItem("ecosentinel_session");
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { company: "Mi Empresa", email: "demo@empresa.com", plan: "Pro" };
  }

  const session = loadSession();
  const nameEl = document.getElementById("userName");
  const planEl = document.getElementById("userPlan");
  if (nameEl) nameEl.textContent = session.company || "Mi Empresa";
  if (planEl) planEl.textContent = "Plan " + (session.plan || "Basic");

  const logout = document.getElementById("logoutBtn");
  if (logout) {
    logout.addEventListener("click", () => {
      try {
        sessionStorage.removeItem("ecosentinel_session");
      } catch (e) {}
      window.location.href = "index.html";
    });
  }

  /* ---------- Contadores animados ---------- */
  function animateNumber(el, target, duration) {
    if (!el) return;
    if (REDUCED) {
      el.textContent = target.toLocaleString("es-MX");
      return;
    }
    const obj = { v: 0 };
    gsap.to(obj, {
      v: target,
      duration: duration || 2,
      ease: "power2.out",
      snap: { v: 1 },
      onUpdate() {
        el.textContent = Math.round(obj.v).toLocaleString("es-MX");
      },
    });
  }

  // Valores base simulados
  let packets = 1842563 + Math.floor(Math.random() * 40000);
  let detected = 3305 + Math.floor(Math.random() * 60);
  let blocked = detected - Math.floor(Math.random() * 8);

  const elPackets = document.getElementById("statPackets");
  const elDetected = document.getElementById("statDetected");
  const elBlocked = document.getElementById("statBlocked");

  animateNumber(elPackets, packets, 2.2);
  animateNumber(elDetected, detected, 2);
  animateNumber(elBlocked, blocked, 2);

  /* ---------- Feed de alertas ---------- */
  const ATTACK_TYPES = ["Ransomware", "DDoS", "Port Scanning", "Botnet Mirai", "Brute Force", "Spoofing"];

  function randIP() {
    const pools = ["192.168", "10.0", "172.16", "45.83", "185.220", "103.94"];
    const base = pools[Math.floor(Math.random() * pools.length)];
    return `${base}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  }
  function fmtTime(d) {
    return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function makeAlert(date) {
    const type = ATTACK_TYPES[Math.floor(Math.random() * ATTACK_TYPES.length)];
    const prob = 0.72 + Math.random() * 0.279; // 0.72 - 0.999
    const blocked = prob >= 0.1; // umbral 0.10 => casi siempre se bloquea
    return { time: date || new Date(), ip: randIP(), type, prob, blocked };
  }

  const alertsBody = document.getElementById("alertsBody");
  const MAX_ROWS = 8;

  function rowHTML(a) {
    const pct = Math.round(a.prob * 100);
    const action = a.blocked
      ? '<span class="badge blocked">Bloqueado</span>'
      : '<span class="badge allowed">Permitido</span>';
    return `
      <td>${fmtTime(a.time)}</td>
      <td><span class="ip">${a.ip}</span></td>
      <td><span class="badge attack">${a.type}</span></td>
      <td>
        <div class="prob-bar">
          <div class="track"><i style="width:${pct}%"></i></div>
          <span>${a.prob.toFixed(2)}</span>
        </div>
      </td>
      <td>${action}</td>`;
  }

  function addAlert(a, animate) {
    if (!alertsBody) return;
    const tr = document.createElement("tr");
    tr.innerHTML = rowHTML(a);
    alertsBody.prepend(tr);
    while (alertsBody.children.length > MAX_ROWS) {
      alertsBody.removeChild(alertsBody.lastChild);
    }
    if (animate && !REDUCED) {
      gsap.from(tr, { backgroundColor: "rgba(255,107,74,0.12)", opacity: 0, y: -8, duration: 0.5, ease: "power2.out" });
    }
  }

  // Semilla inicial de alertas (con horas retrocedidas)
  (function seed() {
    const now = Date.now();
    for (let i = MAX_ROWS - 1; i >= 0; i--) {
      addAlert(makeAlert(new Date(now - i * 90000)), false);
    }
  })();

  // Nuevas alertas periódicas (simulación de tráfico en vivo)
  function liveTick() {
    const a = makeAlert(new Date());
    addAlert(a, true);
    // actualizar contadores
    packets += Math.floor(Math.random() * 500) + 120;
    detected += 1;
    if (a.blocked) blocked += 1;
    if (elPackets) elPackets.textContent = packets.toLocaleString("es-MX");
    if (elDetected) elDetected.textContent = detected.toLocaleString("es-MX");
    if (elBlocked) elBlocked.textContent = blocked.toLocaleString("es-MX");

    setTimeout(liveTick, 3500 + Math.random() * 4000);
  }
  setTimeout(liveTick, 4000);

  // Incremento continuo de paquetes analizados
  if (!REDUCED) {
    setInterval(() => {
      packets += Math.floor(Math.random() * 90) + 20;
      if (elPackets) elPackets.textContent = packets.toLocaleString("es-MX");
    }, 1200);
  }

  /* ---------- Gráfico 24h (canvas nativo) ---------- */
  function drawChart() {
    const canvas = document.getElementById("dash-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight || 240;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Datos simulados por hora
    const hours = 24;
    const det = [];
    const blk = [];
    for (let i = 0; i < hours; i++) {
      const base = 4 + Math.round(Math.abs(Math.sin(i / 3)) * 10 + Math.random() * 6);
      det.push(base);
      blk.push(base - Math.round(Math.random() * 2));
    }
    const maxVal = Math.max(...det) + 4;

    const padL = 30;
    const padB = 24;
    const padT = 10;
    const plotW = cw - padL - 10;
    const plotH = ch - padB - padT;
    const barGroupW = plotW / hours;
    const barW = Math.max(3, barGroupW * 0.34);

    function render(progress) {
      ctx.clearRect(0, 0, cw, ch);

      // grid horizontal + etiquetas
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a7b6";
      ctx.strokeStyle = "rgba(100,116,139,0.15)";
      ctx.lineWidth = 1;
      const steps = 4;
      for (let s = 0; s <= steps; s++) {
        const y = padT + (plotH / steps) * s;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(cw - 10, y);
        ctx.stroke();
        const val = Math.round(maxVal - (maxVal / steps) * s);
        ctx.fillText(val, 4, y + 3);
      }

      // barras
      for (let i = 0; i < hours; i++) {
        const gx = padL + barGroupW * i + barGroupW / 2;
        const dH = (det[i] / maxVal) * plotH * progress;
        const bH = (blk[i] / maxVal) * plotH * progress;

        ctx.fillStyle = "#FF6B4A";
        ctx.fillRect(gx - barW - 1, padT + plotH - dH, barW, dH);
        ctx.fillStyle = "#0EA5A6";
        ctx.fillRect(gx + 1, padT + plotH - bH, barW, bH);

        if (i % 4 === 0) {
          ctx.fillStyle = "#94a7b6";
          ctx.fillText(i + "h", gx - 8, ch - 8);
        }
      }
    }

    if (REDUCED) {
      render(1);
      return;
    }
    const state = { p: 0 };
    gsap.to(state, {
      p: 1,
      duration: 1.4,
      ease: "power2.out",
      onUpdate: () => render(state.p),
    });
  }

  drawChart();
  window.addEventListener("resize", () => {
    // redibujo estático al redimensionar
    const canvas = document.getElementById("dash-chart");
    if (canvas) drawChart();
  });

  /* ---------- Punto de integración con el appliance real ----------
     Cuando el motor de inferencia exponga un WebSocket, sustituir la
     simulación anterior por algo como:

     function connectLive(url) {
       const ws = new WebSocket(url);
       ws.onmessage = (msg) => {
         const evt = JSON.parse(msg.data);
         addAlert({
           time: new Date(evt.timestamp),
           ip: evt.src_ip,
           type: evt.attack_type,
           prob: evt.probability,
           blocked: evt.action === "blocked",
         }, true);
       };
       ws.onclose = () => document.getElementById("statusPill")
         .classList.replace("online", "offline");
     }
  ------------------------------------------------------------------- */
})();
