/* EcoSentinel — password-toggle.js
   "Ver contraseña": convierte cada <input type="password"> en un campo con
   botón de ojo para mostrar/ocultar. Sin librerías: es un botón y un
   `input.type = "text" | "password"`.

   Se aplica solo, buscando los campos que ya están en el DOM al cargar (los
   modales de la landing existen desde el principio aunque estén ocultos). Un
   campo puede excluirse con `data-no-toggle`.

   Accesibilidad:
   - Es un <button type="button">, así que no envía el formulario y se llega
     con Tab y se activa con Enter/Espacio.
   - `aria-label` describe la ACCIÓN y cambia al alternar
     ("Mostrar contraseña" / "Ocultar contraseña").
   - `aria-pressed` expone el estado del interruptor.
   - Los dos SVG son decorativos (`aria-hidden`): quien usa lector de pantalla
     se guía por la etiqueta, no por el icono.
   - El área táctil es de 44x44 px (ver .password-toggle en styles.css).
*/

(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svg(paths, extra) {
    var el = document.createElementNS(SVG_NS, "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("width", "20");
    el.setAttribute("height", "20");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "2");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("aria-hidden", "true");
    if (extra) el.setAttribute("class", extra);
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      el.appendChild(p);
    });
    return el;
  }

  // Ojo abierto (estado: contraseña oculta -> pulsa para mostrar)
  function eyeOpen() {
    var el = svg(["M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z"], "pt-icon pt-eye");
    var c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "12");
    c.setAttribute("cy", "12");
    c.setAttribute("r", "3");
    el.appendChild(c);
    return el;
  }

  // Ojo tachado (estado: contraseña visible -> pulsa para ocultar)
  function eyeOff() {
    return svg(
      [
        "M10.6 6.2A9.9 9.9 0 0 1 12 6c6.2 0 10 6 10 6a17 17 0 0 1-3.2 3.9",
        "M6.6 6.6A17 17 0 0 0 2 12s3.8 7 10 7a9.8 9.8 0 0 0 5.4-1.6",
        "M3 3l18 18",
      ],
      "pt-icon pt-eye-off",
    );
  }

  function enhance(input) {
    if (!input || input.dataset.pwToggle === "on") return;
    if (input.hasAttribute("data-no-toggle")) return;

    var parent = input.parentNode;
    if (!parent) return;

    var wrap = document.createElement("div");
    wrap.className = "password-field";
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "password-toggle";
    btn.setAttribute("aria-label", "Mostrar contraseña");
    btn.setAttribute("aria-pressed", "false");
    // El input ya está etiquetado por su <label>; el botón no debe robarle ese
    // nombre, por eso lleva su propio aria-label y no aria-labelledby.
    btn.appendChild(eyeOpen());
    btn.appendChild(eyeOff());
    wrap.appendChild(btn);

    btn.addEventListener("click", function () {
      var mostrando = input.type === "text";
      input.type = mostrando ? "password" : "text";
      btn.setAttribute("aria-pressed", mostrando ? "false" : "true");
      btn.setAttribute("aria-label", mostrando ? "Mostrar contraseña" : "Ocultar contraseña");
      wrap.classList.toggle("showing", !mostrando);
      // Devolver el foco al campo: quien escribe con el teclado no debería
      // perder el sitio por revisar lo que lleva escrito.
      try {
        var pos = input.value.length;
        input.focus();
        input.setSelectionRange(pos, pos);
      } catch (err) {
        /* setSelectionRange no aplica a algunos tipos; no es crítico */
      }
    });

    input.dataset.pwToggle = "on";
  }

  function enhanceAll() {
    document.querySelectorAll('input[type="password"]').forEach(enhance);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhanceAll);
  } else {
    enhanceAll();
  }
})();
