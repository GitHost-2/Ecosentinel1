/* ============================================================
   EcoSentinel — dashboard.js
   Panel de monitoreo con datos SIMULADOS, adaptado al perfil de
   conocimiento del usuario (ver cuestionario en auth.js).
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
    return { company: "Mi Empresa", email: "demo@empresa.com", plan: "Pro", profile: "intermedio" };
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

  /* ---------- Perfil de conocimiento ----------
     Ajusta el lenguaje y el nivel de detalle de las recomendaciones
     según lo que la persona respondió en el cuestionario de registro. */
  const PROFILES = {
    principiante: {
      label: "Principiante",
      tips: [
        "Activa la verificación en dos pasos en tu correo empresarial: aunque alguien robe tu contraseña, no podrá entrar sin el código extra que solo tú recibes.",
        "Cambia las contraseñas de fábrica de tu router y cámaras (como \"admin123\"); son las primeras que prueba un atacante.",
        "No abras archivos adjuntos de correos inesperados, aunque parezcan venir de un banco o proveedor conocido.",
        "Haz una copia de tus archivos importantes al menos una vez por semana, en un disco externo o en la nube.",
      ],
    },
    intermedio: {
      label: "Intermedio",
      tips: [
        "Configura tu firewall para permitir solo el tráfico entrante que realmente necesitas; cierra los puertos que no usas.",
        "Separa tu red Wi-Fi: invitados y dispositivos IoT en una red aparte de las computadoras con información sensible.",
        "Revisa los registros de acceso de tus sistemas cada semana en busca de intentos de acceso inusuales.",
        "Instala las actualizaciones de seguridad del sistema operativo y del firmware de tu equipo de red en cuanto salgan.",
      ],
    },
    avanzado: {
      label: "Avanzado",
      tips: [
        "Segmenta tu red con VLANs para aislar los dispositivos IoT del resto de tu infraestructura crítica.",
        "Implementa detección de anomalías con líneas base de tráfico (baselining) para reducir falsos negativos ante ataques de día cero.",
        "Habilita autenticación multifactor resistente a phishing (FIDO2/WebAuthn) en todos los accesos administrativos.",
        "Programa pruebas de penetración y ejercicios de Red Team periódicos sobre tu perímetro expuesto.",
      ],
    },
  };
  const profileKeyName = PROFILES[session.profile] ? session.profile : "intermedio";
  const profile = PROFILES[profileKeyName];

  const profileBadge = document.getElementById("profileBadge");
  if (profileBadge) profileBadge.textContent = "Perfil: " + profile.label;

  /* ---------- Recomendaciones + postura de seguridad ---------- */
  function recoStorageKey() {
    return "ecosentinel_reco_" + (session.email || "demo").trim().toLowerCase();
  }
  function loadDoneSet() {
    try {
      const raw = localStorage.getItem(recoStorageKey());
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
      return new Set();
    }
  }
  function saveDoneSet(set) {
    try {
      localStorage.setItem(recoStorageKey(), JSON.stringify([...set]));
    } catch (e) {}
  }

  const recoList = document.getElementById("recoList");
  const recoCount = document.getElementById("recoCount");
  const postureBar = document.getElementById("postureBar");
  const postureValue = document.getElementById("postureValue");
  const POSTURE_R = 52;
  const POSTURE_CIRC = 2 * Math.PI * POSTURE_R;

  if (postureBar) {
    postureBar.setAttribute("stroke-dasharray", POSTURE_CIRC.toFixed(2));
    postureBar.setAttribute("stroke-dashoffset", POSTURE_CIRC.toFixed(2));
  }

  function postureColor(pct) {
    if (pct < 40) return "#C4694A";
    if (pct < 75) return "#D9B44A";
    return "#6FBDB0";
  }

  function updatePosture(doneSet, animate) {
    const total = profile.tips.length;
    const pct = total ? Math.round((doneSet.size / total) * 100) : 0;
    if (recoCount) recoCount.textContent = `${doneSet.size}/${total} aplicadas`;
    if (!postureBar || !postureValue) return;

    const offset = POSTURE_CIRC * (1 - pct / 100);
    const color = postureColor(pct);

    if (REDUCED || !animate) {
      postureBar.style.stroke = color;
      postureBar.setAttribute("stroke-dashoffset", offset.toFixed(2));
      postureValue.textContent = pct + "%";
      return;
    }

    postureBar.style.stroke = color;
    gsap.to(postureBar, { attr: { "stroke-dashoffset": offset }, duration: 0.8, ease: "power2.out" });
    const obj = { v: parseInt(postureValue.textContent, 10) || 0 };
    gsap.to(obj, {
      v: pct,
      duration: 0.8,
      ease: "power2.out",
      snap: { v: 1 },
      onUpdate() {
        postureValue.textContent = obj.v + "%";
      },
    });
  }

  function renderRecommendations() {
    if (!recoList) return;
    const doneSet = loadDoneSet();
    recoList.innerHTML = "";
    profile.tips.forEach((tip, i) => {
      const li = document.createElement("li");
      li.className = "reco-item" + (doneSet.has(i) ? " done" : "");
      li.innerHTML = `
        <span class="reco-check" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>
        </span>
        <span class="reco-text">${tip}</span>`;
      li.addEventListener("click", () => {
        if (doneSet.has(i)) doneSet.delete(i);
        else doneSet.add(i);
        li.classList.toggle("done");
        saveDoneSet(doneSet);
        updatePosture(doneSet, true);
      });
      recoList.appendChild(li);
    });
    updatePosture(doneSet, !REDUCED);
  }

  renderRecommendations();

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
      gsap.from(tr, { backgroundColor: "rgba(196,105,74,0.16)", opacity: 0, y: -8, duration: 0.5, ease: "power2.out" });
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
      ctx.fillStyle = "#8b99a6";
      ctx.strokeStyle = "rgba(139,153,166,0.15)";
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

        ctx.fillStyle = "#C4694A";
        ctx.fillRect(gx - barW - 1, padT + plotH - dH, barW, dH);
        ctx.fillStyle = "#2F8F86";
        ctx.fillRect(gx + 1, padT + plotH - bH, barW, bH);

        if (i % 4 === 0) {
          ctx.fillStyle = "#8b99a6";
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

  /* ---------- Distribución de amenazas (dona animada) ---------- */
  function drawDistribution() {
    const canvas = document.getElementById("distChart");
    const legendEl = document.getElementById("distLegend");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = canvas.clientWidth || 220;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const data = [
      { label: "Ransomware", pct: 22, color: "#C4694A" },
      { label: "Brute Force", pct: 20, color: "#6FBDB0" },
      { label: "Port Scanning", pct: 18, color: "#D9B44A" },
      { label: "DDoS", pct: 16, color: "#4A90C4" },
      { label: "Botnets Mirai", pct: 14, color: "#8C6FBD" },
      { label: "Spoofing", pct: 10, color: "#8b99a6" },
    ];

    if (legendEl) {
      legendEl.innerHTML = data
        .map((d) => `<li><i style="background:${d.color}"></i>${d.label}<b>${d.pct}%</b></li>`)
        .join("");
    }

    const cx = size / 2;
    const cy = size / 2;
    const rOuter = size / 2 - 6;
    const rInner = rOuter * 0.6;

    function render(progress) {
      ctx.clearRect(0, 0, size, size);
      let start = -Math.PI / 2;
      data.forEach((d) => {
        const sweep = (d.pct / 100) * Math.PI * 2 * progress;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, rOuter, start, start + sweep);
        ctx.closePath();
        ctx.fillStyle = d.color;
        ctx.fill();
        start += sweep;
      });
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }

    if (REDUCED) {
      render(1);
      return;
    }
    const state = { p: 0 };
    gsap.to(state, { p: 1, duration: 1.6, ease: "power2.out", onUpdate: () => render(state.p) });
  }

  drawDistribution();
  window.addEventListener("resize", () => {
    const canvas = document.getElementById("distChart");
    if (canvas) drawDistribution();
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
