/* ============================================================
   EcoSentinel — auth.js
   Modales de login / registro. Las cuentas viven en Postgres (tabla
   `users`, ver /api/auth/register, /api/auth/login, /api/auth/profile).
   La sesión del navegador (sessionStorage) sigue siendo solo una copia
   local de conveniencia para que dashboard.js sepa quién entró.
   ============================================================ */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const overlays = {
    login: document.getElementById("loginOverlay"),
    register: document.getElementById("registerOverlay"),
    quiz: document.getElementById("quizOverlay"),
  };
  const modals = {
    login: document.getElementById("loginModal"),
    register: document.getElementById("registerModal"),
    quiz: document.getElementById("quizModal"),
  };

  let lastFocused = null;
  // Datos de registro a la espera de que se responda el cuestionario
  // de perfil (ver initQuiz). Si el usuario cierra el cuestionario sin
  // responder, se completa el registro con un perfil por defecto.
  let pendingRegistration = null;

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
      gsap.fromTo(
        modal,
        { opacity: 0, scale: 0.9, y: 20 },
        { opacity: 1, scale: 1, y: 0, duration: 0.35, ease: "back.out(1.6)" }
      );
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
      // Si cierran el cuestionario sin responderlo, no dejamos al
      // usuario atorado: completamos el registro con un perfil por
      // defecto para que pueda entrar a su panel de todas formas.
      if (name === "quiz" && pendingRegistration) {
        finishRegistration("intermedio");
      }
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

  /* ---------- Registro/login contra la API (Postgres) ---------- */
  function setFormBusy(form, busy) {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = busy;
  }

  async function finishRegistration(profile) {
    if (!pendingRegistration) return;
    const { email } = pendingRegistration;
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, profile }),
      });
      if (!res.ok) throw new Error("profile update failed");
    } catch (err) {
      // El registro ya existe en la BD; si esto falla, el perfil se
      // queda en su default ("intermedio") y no bloquea el acceso.
    }
    const data = { ...pendingRegistration, profile };
    pendingRegistration = null;
    saveSession(data);
    redirectToDashboard();
  }

  /* ---------- Login ---------- */
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
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

      setFormBusy(loginForm, true);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: pass }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(loginForm, "password", data.error || "Correo o contraseña incorrectos.");
          shake(modals.login);
          return;
        }
        saveSession({ company: data.company, email: data.email, plan: data.plan, profile: data.profile });
        redirectToDashboard();
      } catch (err) {
        setError(loginForm, "password", "No se pudo conectar con el servidor. Intenta de nuevo.");
        shake(modals.login);
      } finally {
        setFormBusy(loginForm, false);
      }
    });
  }

  /* ---------- Registro ---------- */
  const registerForm = document.getElementById("registerForm");
  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
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

      setFormBusy(registerForm, true);
      try {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company, email, plan, password: pass }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(registerForm, "email", data.error || "No se pudo completar el registro.");
          shake(modals.register);
          return;
        }
        pendingRegistration = { company, email, plan };
        closeModal("register");
        setTimeout(() => openModal("quiz"), REDUCED ? 0 : 220);
      } catch (err) {
        setError(registerForm, "email", "No se pudo conectar con el servidor. Intenta de nuevo.");
        shake(modals.register);
      } finally {
        setFormBusy(registerForm, false);
      }
    });
  }

  /* ---------- Cuestionario de perfil ---------- */
  const quizForm = document.getElementById("quizForm");
  if (quizForm) {
    quizForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!pendingRegistration) return;
      const data = new FormData(quizForm);
      const score = ["q1", "q2", "q3"].reduce((sum, key) => sum + (parseInt(data.get(key), 10) || 2), 0);
      const profile = score <= 4 ? "principiante" : score <= 7 ? "intermedio" : "avanzado";
      finishRegistration(profile);
    });
  }

  function redirectToDashboard() {
    if (REDUCED) {
      window.location.href = "/dashboard";
      return;
    }
    // Pequeña transición de salida antes de redirigir
    gsap.to("body", {
      opacity: 0,
      duration: 0.3,
      ease: "power1.in",
      onComplete: () => (window.location.href = "/dashboard"),
    });
  }
})();
