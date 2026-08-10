/* EcoSentinel — auth-forms.js
   Formularios de las páginas /forgot y /reset. Vanilla, sin GSAP: estas dos
   páginas son un formulario y nada más, y deben funcionar rápido también en un
   móvil con mala conexión.

   El mismo archivo sirve a las dos páginas: cada bloque se activa solo si
   encuentra su formulario. */

(function () {
  "use strict";

  function setError(form, campo, msg) {
    var el = form.querySelector('[data-error="' + campo + '"]');
    if (el) el.textContent = msg || "";
  }

  function clearErrors(form) {
    form.querySelectorAll(".error-msg").forEach(function (el) {
      el.textContent = "";
    });
  }

  function nota(el, texto, tipo) {
    if (!el) return;
    el.textContent = texto || "";
    el.className = "auth-note" + (tipo ? " " + tipo : "");
  }

  function setBusy(form, busy) {
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = busy;
  }

  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  /* ---------------- /forgot ---------------- */
  var forgotForm = document.getElementById("forgotForm");
  if (forgotForm) {
    var forgotNote = document.getElementById("forgotNote");

    forgotForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearErrors(forgotForm);
      nota(forgotNote, "");

      var email = forgotForm.email.value.trim();
      if (!isEmail(email)) {
        setError(forgotForm, "email", "Ingresa un correo válido.");
        return;
      }

      setBusy(forgotForm, true);
      try {
        var res = await fetch("/api/auth/forgot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        });
        var data = await res.json().catch(function () {
          return {};
        });

        if (res.status === 429) {
          nota(forgotNote, data.error || "Demasiadas solicitudes. Espera unos minutos.", "warn");
          return;
        }

        // El servidor responde lo mismo exista o no la cuenta, a propósito:
        // así esta pantalla no sirve para averiguar qué correos están
        // registrados. La interfaz no debe "mejorar" ese mensaje.
        nota(
          forgotNote,
          data.message || "Si el correo existe, enviamos instrucciones para restablecer la contraseña.",
          "ok",
        );
        forgotForm.reset();
      } catch (err) {
        nota(forgotNote, "No se pudo conectar con el servidor. Intenta de nuevo.", "warn");
      } finally {
        setBusy(forgotForm, false);
      }
    });
  }

  /* ---------------- /reset ---------------- */
  var resetForm = document.getElementById("resetForm");
  if (resetForm) {
    var resetNote = document.getElementById("resetNote");

    // El token se lee UNA vez y se guarda en memoria; después se borra de la
    // barra de direcciones. Así no queda a la vista, no se copia sin querer al
    // compartir la URL y no viaja en la cabecera Referer de peticiones
    // posteriores.
    var token = "";
    try {
      token = new URLSearchParams(window.location.search).get("token") || "";
      if (token && window.history && window.history.replaceState) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (err) {
      token = "";
    }

    if (!token) {
      nota(
        resetNote,
        "Falta el enlace de recuperación. Abre el enlace del correo o pide uno nuevo.",
        "warn",
      );
      setBusy(resetForm, true);
    }

    resetForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearErrors(resetForm);
      nota(resetNote, "");

      var pass = resetForm.password.value;
      var confirm = resetForm.confirm.value;
      var ok = true;

      // Misma política que el servidor (lib/password-reset.ts). Aquí es solo
      // para avisar antes de la ida y vuelta: quien manda es el servidor.
      if (pass.length < 8) {
        setError(resetForm, "password", "La contraseña debe tener al menos 8 caracteres.");
        ok = false;
      }
      if (confirm !== pass) {
        setError(resetForm, "confirm", "Las contraseñas no coinciden.");
        ok = false;
      }
      if (!ok) return;

      setBusy(resetForm, true);
      try {
        var res = await fetch("/api/auth/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token, password: pass }),
        });
        var data = await res.json().catch(function () {
          return {};
        });

        if (!res.ok) {
          nota(resetNote, data.error || "No se pudo cambiar la contraseña.", "warn");
          setBusy(resetForm, false);
          return;
        }

        nota(resetNote, data.message || "Tu contraseña se actualizó.", "ok");
        resetForm.reset();
        // El token ya se quemó: el formulario se queda deshabilitado a
        // propósito y la página se va sola al inicio para iniciar sesión.
        setTimeout(function () {
          window.location.href = "/";
        }, 2500);
      } catch (err) {
        nota(resetNote, "No se pudo conectar con el servidor. Intenta de nuevo.", "warn");
        setBusy(resetForm, false);
      }
    });
  }
})();
