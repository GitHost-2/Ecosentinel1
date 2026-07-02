/* ============================================================
   EcoSentinel — auth.js
   Modales de login / registro, validación y simulación de auth.
   Nota: la autenticación es una SIMULACIÓN de front-end. Cuando se
   conecte al appliance real, este flujo se sustituirá por peticiones
   al backend del motor de inferencia.
   ============================================================ */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const overlays = {
    login: document.getElementById("loginOverlay"),
    register: document.getElementById("registerOverlay"),
  };
  const modals = {
    login: document.getElementById("loginModal"),
    register: document.getElementById("registerModal"),
  };

  let lastFocused = null;

  /* ---------- Abrir / cerrar con animación GSAP ---------- */
  function openModal(name) {
    const overlay = overlays[name];
    const modal = modals[name];
    if (!overlay || !modal) return;
    lastFocused = document.activeElement;
    overlay.classList.add("open");

    if (REDUCED) {
      gsap.set([overlay, modal], { opacity: 1, scale: 1 });
    } else {
      gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power1.out" });
      gsap.from(modal, { opacity: 0, scale: 0.9, y: 20, duration: 0.35, ease: "back.out(1.6)" });
    }

    const firstInput = modal.querySelector("input, select");
    if (firstInput) setTimeout(() => firstInput.focus(), 60);
    document.body.style.overflow = "hidden";
  }

  function closeModal(name) {
    const overlay = overlays[name];
    const modal = modals[name];
    if (!overlay || !modal) return;

    const finish = () => {
      overlay.classList.remove("open");
      document.body.style.overflow = "";
      if (lastFocused) lastFocused.focus();
    };

    if (REDUCED) {
      finish();
    } else {
      gsap.to(modal, { opacity: 0, scale: 0.92, y: 10, duration: 0.2, ease: "power1.in" });
      gsap.to(overlay, { opacity: 0, duration: 0.25, delay: 0.05, onComplete: finish });
    }
  }

  function closeAll() {
    Object.keys(overlays).forEach((name) => {
      if (overlays[name] && overlays[name].classList.contains("open")) closeModal(name);
    });
  }

  /* ---------- Wiring de disparadores ---------- */
  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      closeAll();
      openModal(btn.getAttribute("data-open"));
    });
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const overlay = btn.closest(".modal-overlay");
      if (overlay === overlays.login) closeModal("login");
      else if (overlay === overlays.register) closeModal("register");
    });
  });

  // Cerrar al hacer clic fuera del modal
  Object.entries(overlays).forEach(([name, overlay]) => {
    if (!overlay) return;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(name);
    });
  });

  // Cerrar con Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll();
  });

  // Cambiar entre login y registro
  document.querySelectorAll("[data-switch]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const target = link.getAttribute("data-switch");
      closeAll();
      setTimeout(() => openModal(target), REDUCED ? 0 : 220);
    });
  });

  /* ---------- Validación ---------- */
  function setError(form, field, msg) {
    const el = form.querySelector(`[data-error="${field}"]`);
    if (el) el.textContent = msg || "";
  }
  function clearErrors(form) {
    form.querySelectorAll(".error-msg").forEach((el) => (el.textContent = ""));
  }
  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }
  function shake(modal) {
    if (REDUCED) return;
    gsap.fromTo(modal, { x: -8 }, { x: 0, duration: 0.4, ease: "elastic.out(1,0.4)" });
  }

  function saveSession(data) {
    // Simulación: guardamos la sesión para que el dashboard la lea.
    try {
      sessionStorage.setItem("ecosentinel_session", JSON.stringify(data));
    } catch (err) {
      /* almacenamiento no disponible */
    }
  }

  /* ---------- Login ---------- */
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      clearErrors(loginForm);
      const email = loginForm.email.value.trim();
      const pass = loginForm.password.value;
      let ok = true;

      if (!isEmail(email)) {
        setError(loginForm, "email", "Ingresa un correo válido.");
        ok = false;
      }
      if (pass.length < 6) {
        setError(loginForm, "password", "La contraseña debe tener al menos 6 caracteres.");
        ok = false;
      }
      if (!ok) {
        shake(modals.login);
        return;
      }

      const company = email.split("@")[0].replace(/[._-]+/g, " ");
      saveSession({ company: company || "Mi Empresa", email, plan: "Pro" });
      redirectToDashboard();
    });
  }

  /* ---------- Registro ---------- */
  const registerForm = document.getElementById("registerForm");
  if (registerForm) {
    registerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      clearErrors(registerForm);
      const company = registerForm.company.value.trim();
      const email = registerForm.email.value.trim();
      const plan = registerForm.plan.value;
      const pass = registerForm.password.value;
      const confirm = registerForm.confirm.value;
      let ok = true;

      if (company.length < 2) {
        setError(registerForm, "company", "Ingresa el nombre de tu empresa.");
        ok = false;
      }
      if (!isEmail(email)) {
        setError(registerForm, "email", "Ingresa un correo válido.");
        ok = false;
      }
      if (pass.length < 8) {
        setError(registerForm, "password", "La contraseña debe tener al menos 8 caracteres.");
        ok = false;
      }
      if (confirm !== pass) {
        setError(registerForm, "confirm", "Las contraseñas no coinciden.");
        ok = false;
      }
      if (!ok) {
        shake(modals.register);
        return;
      }

      saveSession({ company, email, plan });
      redirectToDashboard();
    });
  }

  function redirectToDashboard() {
    if (REDUCED) {
      window.location.href = "dashboard.html";
      return;
    }
    // Pequeña transición de salida antes de redirigir
    gsap.to("body", {
      opacity: 0,
      duration: 0.3,
      ease: "power1.in",
      onComplete: () => (window.location.href = "dashboard.html"),
    });
  }
})();
