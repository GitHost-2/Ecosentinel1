/* EcoSentinel — dashboard.js
   Panel con datos reales de Postgres vía /api/stats, /api/alerts,
   /api/hourly y /api/threats, refrescados por polling. */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Todo lo que venga de la API y se inserte con innerHTML pasa por aquí.
  // `nombre_cliente` y `attack_type` vienen de la base de datos, así que un
  // valor con HTML se ejecutaría en el navegador de quien vea el dashboard.
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Si la sesión venció o no hay, el servidor responde 401: en vez de dejar
  // el dashboard con ceros, se manda a la persona de vuelta al login.
  let redirecting = false;
  async function apiGet(url) {
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) {
      if (!redirecting) {
        redirecting = true;
        window.location.href = "/";
      }
      throw new Error("sesión no válida");
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  if (window.ScrambleTextPlugin) gsap.registerPlugin(ScrambleTextPlugin);

  function scrambleReveal(el, fullText, opts) {
    opts = opts || {};
    if (REDUCED || !window.ScrambleTextPlugin) {
      el.textContent = fullText;
      if (opts.onComplete) opts.onComplete();
      return;
    }
    el.textContent = "";
    gsap.to(el, {
      duration: opts.duration || 1.3,
      ease: "power1.inOut",
      scrambleText: { text: fullText, chars: "upperAndLowerCase", revealDelay: 0.2, tweenLength: true },
      onComplete: opts.onComplete,
    });
  }

  /* ---------- Overlay de proceso (validar / mitigar) ---------- */
  const processOverlay = document.getElementById("processOverlay");
  const processTitle = document.getElementById("processTitle");
  const processBarFill = document.getElementById("processBarFill");
  const processStatus = document.getElementById("processStatus");

  function runProcess(opts) {
    const duration = opts.duration || 20;
    const messages = opts.messages && opts.messages.length ? opts.messages : ["Procesando…"];
    const onComplete = opts.onComplete || function () {};

    if (!processOverlay) {
      onComplete();
      return;
    }

    if (processTitle) processTitle.textContent = opts.title || "Procesando…";
    if (processStatus) processStatus.textContent = messages[0];
    if (processBarFill) {
      gsap.killTweensOf(processBarFill);
      processBarFill.style.width = "0%";
    }
    document.body.style.overflow = "hidden";
    processOverlay.classList.add("open");

    let msgIndex = 0;
    const msgEvery = Math.max(1800, (duration * 1000) / (messages.length * 1.4));
    const msgInterval = setInterval(() => {
      msgIndex = (msgIndex + 1) % messages.length;
      if (processStatus) processStatus.textContent = messages[msgIndex];
    }, msgEvery);

    function finish() {
      clearInterval(msgInterval);
      processOverlay.classList.remove("open");
      document.body.style.overflow = "";
      onComplete();
    }

    if (REDUCED) {
      if (processBarFill) processBarFill.style.width = "100%";
      setTimeout(finish, Math.min(duration * 1000, 700));
    } else {
      if (processBarFill) gsap.to(processBarFill, { width: "100%", duration, ease: "power1.inOut" });
      setTimeout(finish, duration * 1000);
    }
  }

  /* ---------- Sesión ---------- */
  function loadSession() {
    try {
      const raw = sessionStorage.getItem("ecosentinel_session");
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { company: "Mi Cuenta", email: "demo@ejemplo.com", plan: "Pro", profile: "intermedio" };
  }

  const session = loadSession();
  const nameEl = document.getElementById("userName");
  const planEl = document.getElementById("userPlan");
  if (nameEl) nameEl.textContent = session.company || "Mi Cuenta";
  if (planEl) planEl.textContent = "Plan " + (session.plan || "Basic");

  const logout = document.getElementById("logoutBtn");
  if (logout) {
    logout.addEventListener("click", async () => {
      try {
        sessionStorage.removeItem("ecosentinel_session");
      } catch (e) {}
      // Además de limpiar el navegador, invalida la cookie del servidor.
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch (e) {}
      window.location.href = "/";
    });
  }

  /* ---------- Filtro de dispositivo (persiste en sessionStorage) ---------- */
  const DEVICE_FILTER_KEY = "ecosentinel_device_filter";
  let currentDeviceId = "";
  try {
    currentDeviceId = sessionStorage.getItem(DEVICE_FILTER_KEY) || "";
  } catch (e) {}
  let devicesList = [];

  const deviceSelect = document.getElementById("deviceSelect");
  const statusPill = document.getElementById("statusPill");

  function withDeviceParam(url) {
    if (!currentDeviceId) return url;
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "deviceId=" + encodeURIComponent(currentDeviceId);
  }

  function updateStatusPill() {
    if (!statusPill) return;
    const relevant = currentDeviceId
      ? devicesList.filter((d) => String(d.id) === String(currentDeviceId))
      : devicesList;
    const anyOnline = relevant.length > 0 && relevant.some((d) => d.online);
    statusPill.classList.toggle("online", anyOnline);
    statusPill.classList.toggle("offline", !anyOnline);
    statusPill.innerHTML = anyOnline
      ? '<span class="dot"></span> Appliance conectado'
      : '<span class="dot"></span> Appliance desconectado';
  }

  async function loadDevices() {
    try {
      devicesList = await apiGet("/api/devices");
    } catch (e) {
      console.error("No se pudo cargar /api/devices", e);
      devicesList = [];
    }

    if (deviceSelect) {
      const stillValid = devicesList.some((d) => String(d.id) === String(currentDeviceId));
      if (!stillValid) currentDeviceId = "";

      deviceSelect.innerHTML =
        '<option value="">Todos los dispositivos</option>' +
        devicesList.map((d) => `<option value="${esc(d.id)}">${esc(d.nombreCliente)}</option>`).join("");
      deviceSelect.value = currentDeviceId;
    }

    updateStatusPill();
  }

  function resetAndReload() {
    packets = 0;
    detected = 0;
    blocked = 0;
    knownAlertIds.clear();
    if (alertsBody) alertsBody.innerHTML = "";
    loadDashboardData();
  }

  if (deviceSelect) {
    deviceSelect.addEventListener("change", () => {
      currentDeviceId = deviceSelect.value;
      try {
        sessionStorage.setItem(DEVICE_FILTER_KEY, currentDeviceId);
      } catch (e) {}
      updateStatusPill();
      resetAndReload();
    });
  }

  /* ---------- Perfil de conocimiento (ajusta las recomendaciones) ---------- */
  const PROFILES = {
    principiante: {
      label: "Principiante",
      tips: [
        "Activa la verificación en dos pasos en tu correo: aunque alguien robe tu contraseña, no podrá entrar sin el código extra que solo tú recibes.",
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
  const recoValidateWrap = document.getElementById("recoValidateWrap");
  const recoValidateBtn = document.getElementById("recoValidateBtn");
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

  function updateValidateButton(doneSet) {
    if (!recoValidateWrap || !recoValidateBtn) return;
    if (doneSet.size > 0) {
      if (recoValidateWrap.hidden) {
        recoValidateWrap.hidden = false;
        scrambleReveal(recoValidateBtn, "Validar", { duration: 1.3 });
      }
    } else {
      recoValidateWrap.hidden = true;
      recoValidateBtn.textContent = "Validar";
      recoValidateBtn.disabled = false;
      recoValidateBtn.classList.remove("validated");
    }
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
        updateValidateButton(doneSet);
      });
      recoList.appendChild(li);
    });
    updatePosture(doneSet, !REDUCED);
    updateValidateButton(doneSet);
  }

  renderRecommendations();

  if (recoValidateBtn) {
    recoValidateBtn.addEventListener("click", () => {
      if (recoValidateBtn.disabled) return;
      recoValidateBtn.disabled = true;
      runProcess({
        title: "Validando recomendaciones en tu red",
        duration: 20,
        messages: [
          "Sincronizando con el appliance…",
          "Verificando reglas de firewall…",
          "Comprobando configuración de red…",
          "Confirmando cambios aplicados…",
        ],
        onComplete: () => {
          recoValidateBtn.textContent = "✓ Validado";
          recoValidateBtn.classList.add("validated");
          setTimeout(() => {
            recoValidateBtn.textContent = "Validar";
            recoValidateBtn.classList.remove("validated");
            recoValidateBtn.disabled = false;
          }, 2500);
        },
      });
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

  // Cargados desde /api/stats en init(); arrancan en 0 y se animan al llegar la respuesta.
  let packets = 0;
  let detected = 0;
  let blocked = 0;

  const elPackets = document.getElementById("statPackets");
  const elDetected = document.getElementById("statDetected");
  const elBlocked = document.getElementById("statBlocked");

  /* ---------- Feed de alertas ---------- */
  function fmtTime(d) {
    return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  const alertsBody = document.getElementById("alertsBody");
  const MAX_ROWS = 8;

  // `a.ip` es el hash de la IP (nunca la IP real); se trunca para la tabla, completo en el title.
  function truncatedHash(hash) {
    if (!hash || hash.length <= 12) return hash || "";
    return hash.slice(0, 10) + "…";
  }

  function rowHTML(a) {
    const pct = Math.round(a.prob * 100);
    const statusBadge = a.blocked
      ? '<span class="badge blocked">Bloqueado</span>'
      : '<span class="badge allowed">Permitido</span>';
    // Solo se puede aislar lo que ya cuenta como bloqueado (alta confianza,
    // prob >= 0.7) -- misma validación que exige app/api/mitigate/route.ts.
    const isolateBtn = a.blocked
      ? `<button class="btn btn-outline-dark isolate-btn" data-isolate="${esc(a.id)}"${a.mitigated ? " disabled" : ""}>${
          a.mitigated ? "Aislado ✓" : "Aislar IP"
        }</button>`
      : "";
    return `
      <td>${esc(fmtTime(a.time))}</td>
      <td><span class="ip" title="${esc(a.ip)}">${esc(truncatedHash(a.ip))}</span></td>
      <td><span class="badge attack">${esc(a.type)}</span></td>
      <td>
        <div class="prob-bar">
          <div class="track"><i style="width:${pct}%"></i></div>
          <span>${a.prob.toFixed(2)}</span>
        </div>
      </td>
      <td class="action-cell">${statusBadge}${isolateBtn}</td>`;
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

  if (alertsBody) {
    alertsBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-isolate]");
      if (!btn || btn.disabled) return;
      const detectionId = Number(btn.getAttribute("data-isolate"));
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Aislando…";
      try {
        const res = await fetch("/api/mitigate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detectionId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "No se pudo procesar la solicitud.");
        btn.textContent = "Aislado ✓";
        openIsolateModal(data.guidance);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = originalText;
        window.alert("No se pudo aislar la IP: " + err.message);
      }
    });
  }

  const POLL_INTERVAL_MS = 6000;
  const HEAVY_POLL_EVERY = 5; // refresca hourly/threats cada N polls (~30s)
  const knownAlertIds = new Set();
  let pollCount = 0;

  async function pollStatsAndAlerts() {
    try {
      const stats = await apiGet(withDeviceParam("/api/stats"));
      if (stats.packets !== packets) tweenStatTo(elPackets, packets, stats.packets, 1);
      if (stats.detected !== detected) tweenStatTo(elDetected, detected, stats.detected, 1);
      if (stats.blocked !== blocked) tweenStatTo(elBlocked, blocked, stats.blocked, 1);
      packets = stats.packets;
      detected = stats.detected;
      blocked = stats.blocked;
      refreshThreatCounts();
    } catch (e) {
      console.error("No se pudo refrescar /api/stats", e);
    }

    try {
      const alerts = await apiGet(withDeviceParam("/api/alerts?limit=20"));
      const fresh = alerts.filter((a) => !knownAlertIds.has(a.id)).reverse(); // más viejo primero
      fresh.forEach((a) => {
        knownAlertIds.add(a.id);
        addAlert({ id: a.id, time: new Date(a.time), ip: a.ip, type: a.type, prob: a.prob, blocked: a.blocked, mitigated: a.mitigated }, true);
      });
    } catch (e) {
      console.error("No se pudo refrescar /api/alerts", e);
    }

    pollCount++;
    if (pollCount % HEAVY_POLL_EVERY === 0) {
      try {
        hourlyData = await apiGet(withDeviceParam("/api/hourly"));
        drawChart();
      } catch (e) {
        console.error("No se pudo refrescar /api/hourly", e);
      }
      try {
        THREATS = await apiGet(withDeviceParam("/api/threats"));
        drawDistribution();
        renderThreatCards();
      } catch (e) {
        console.error("No se pudo refrescar /api/threats", e);
      }
      loadDevices(); // refresca online/offline y la lista del selector
    }
  }

  function startLivePolling() {
    setInterval(pollStatsAndAlerts, POLL_INTERVAL_MS);
  }

  /* ---------- Gráfico 24h (canvas nativo) ---------- */
  let hourlyData = null;

  function drawChart() {
    const canvas = document.getElementById("dash-chart");
    if (!canvas || !hourlyData) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight || 240;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const hours = 24;
    const det = hourlyData.detected;
    const blk = hourlyData.blocked;
    const maxVal = Math.max(...det, 1) + 4;

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

  window.addEventListener("resize", () => {
    const canvas = document.getElementById("dash-chart");
    if (canvas) drawChart();
  });

  /* ---------- Amenazas: datos compartidos entre la dona y las tarjetas ---------- */
  let THREATS = [];

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

    const data = THREATS;

    if (legendEl) {
      legendEl.innerHTML = data
        .map((d) => `<li><i style="background:${esc(d.color)}"></i>${esc(d.label)}<b>${esc(d.pct)}%</b></li>`)
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

  window.addEventListener("resize", () => {
    const canvas = document.getElementById("distChart");
    if (canvas) drawDistribution();
  });

  /* ---------- Amenazas activas en tu red (tarjetas) ---------- */
  function tweenStatTo(el, from, to, duration) {
    if (!el) return;
    if (REDUCED) {
      el.textContent = Math.round(to).toLocaleString("es-MX");
      return;
    }
    const obj = { v: from };
    gsap.to(obj, {
      v: to,
      duration: duration || 1.6,
      ease: "power2.inOut",
      snap: { v: 1 },
      onUpdate() {
        el.textContent = Math.round(obj.v).toLocaleString("es-MX");
      },
    });
  }

  function refreshThreatCounts() {
    document.querySelectorAll(".threat-mini-card").forEach((card) => {
      const t = THREATS.find((x) => x.key === card.getAttribute("data-threat"));
      const countEl = card.querySelector(".tmc-count");
      if (t && countEl) {
        countEl.textContent = Math.max(1, Math.round((detected * t.pct) / 100)).toLocaleString("es-MX");
      }
    });
  }

  // El botón "Mitigar" que reducía los contadores con Math.random() se quitó:
  // era puramente cosmético, no tocaba nada real. La acción real de aislar
  // una IP vive ahora en la tabla de alertas (ver btn-isolate más abajo),
  // sobre una detección específica, no sobre una categoría agregada.
  function renderThreatCards() {
    const grid = document.getElementById("threatsGrid");
    if (!grid) return;

    grid.innerHTML = THREATS.map((t) => {
      const count = Math.max(1, Math.round((detected * t.pct) / 100));
      return `
        <div class="threat-mini-card" data-threat="${esc(t.key)}">
          <div class="tmc-head">
            <span class="tmc-dot" style="background:${esc(t.color)}"></span>
            <span class="tmc-name">${esc(t.label)}</span>
            <span class="tmc-count">${esc(count.toLocaleString("es-MX"))}</span>
          </div>
          <ul class="tmc-tips" hidden>${t.tips.map((tip) => `<li>${esc(tip)}</li>`).join("")}</ul>
          <div class="tmc-actions">
            <button class="btn btn-outline-dark tmc-action" data-action="review">Tomar acciones</button>
          </div>
        </div>`;
    }).join("");

    grid.querySelectorAll(".threat-mini-card").forEach((card) => {
      const tips = card.querySelector(".tmc-tips");
      const reviewBtn = card.querySelector('[data-action="review"]');
      let expanded = false;

      reviewBtn.addEventListener("click", () => {
        expanded = !expanded;
        if (expanded) {
          tips.hidden = false;
          if (!REDUCED) gsap.from(tips, { height: 0, opacity: 0, duration: 0.35, ease: "power2.out" });
          reviewBtn.textContent = "Ocultar";
        } else {
          tips.hidden = true;
          reviewBtn.textContent = "Tomar acciones";
        }
      });
    });
  }

  /* ---------- Aislar IP: acción real sobre una detección de alta confianza ----------
     Nunca toca la red sola (la RPi es cliente WiFi, no está en línea en la
     red -- no puede bloquear tráfico ajeno). Confirma en el backend
     (POST /api/mitigate, exige prob >= 0.7) y muestra la guía para
     bloquear la IP real donde sí se puede: el router del cliente. */
  const isolateOverlay = document.getElementById("isolateOverlay");
  const isolateCmd = document.getElementById("isolateCmd");
  const isolateSteps = document.getElementById("isolateSteps");

  function openIsolateModal(guidance) {
    if (!isolateOverlay) return;
    if (isolateCmd) isolateCmd.textContent = guidance.findRealIpCommand;
    if (isolateSteps) isolateSteps.innerHTML = guidance.steps.map((s) => `<li>${esc(s)}</li>`).join("");
    isolateOverlay.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeIsolateModal() {
    if (!isolateOverlay) return;
    isolateOverlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  document.querySelectorAll("[data-close-isolate]").forEach((btn) => btn.addEventListener("click", closeIsolateModal));
  if (isolateOverlay) {
    isolateOverlay.addEventListener("click", (e) => {
      if (e.target === isolateOverlay) closeIsolateModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeIsolateModal();
  });

  /* ---------- Carga inicial desde la base de datos ---------- */
  async function loadDashboardData() {
    try {
      const stats = await apiGet(withDeviceParam("/api/stats"));
      packets = stats.packets;
      detected = stats.detected;
      blocked = stats.blocked;
      animateNumber(elPackets, packets, 2.2);
      animateNumber(elDetected, detected, 2);
      animateNumber(elBlocked, blocked, 2);
    } catch (e) {
      console.error("No se pudo cargar /api/stats", e);
    }

    try {
      const alerts = await apiGet(withDeviceParam("/api/alerts?limit=" + MAX_ROWS));
      // Se recorre al revés porque addAlert() hace prepend.
      alerts
        .slice()
        .reverse()
        .forEach((a) => {
          knownAlertIds.add(a.id);
          addAlert({ id: a.id, time: new Date(a.time), ip: a.ip, type: a.type, prob: a.prob, blocked: a.blocked, mitigated: a.mitigated }, false);
        });
    } catch (e) {
      console.error("No se pudo cargar /api/alerts", e);
    }

    try {
      hourlyData = await apiGet(withDeviceParam("/api/hourly"));
      drawChart();
    } catch (e) {
      console.error("No se pudo cargar /api/hourly", e);
    }

    try {
      THREATS = await apiGet(withDeviceParam("/api/threats"));
      drawDistribution();
      renderThreatCards();
    } catch (e) {
      console.error("No se pudo cargar /api/threats", e);
    }
  }

  async function init() {
    await loadDevices();
    await loadDashboardData();
    startLivePolling();
  }

  init();
})();
