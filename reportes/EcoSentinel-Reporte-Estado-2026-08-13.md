# EcoSentinel — Reporte de estado

**Fecha:** 2026-08-13
**Alcance:** continuación de la sesión 2026-08-10. Calibración, limpieza de credenciales de laboratorio, documentación técnica versionada en el repositorio.

---

## 1. Resumen ejecutivo

- **Repositorio:** `origin/main` = `894432a` (antes de esta sesión), sincronizado.
- **Rig de calibración:** actualizado al motor de producción actual (`8fe5229d…`), listo para correr en un solo comando.
- **Calibración de las 5 familias sin validar:** **bloqueada para el agente** — genera tráfico de ataque real, y el clasificador de seguridad del agente lo impide (mismo criterio que bloqueó `flood.py` en sesiones previas). Debe correrla el operador.
- **Topología Cisco:** las dos configuraciones (`config-router.txt`, `config-switch.txt`) quedaron **sin ninguna contraseña** — son dispositivos de laboratorio compartidos, a petición explícita del usuario.
- **Documentación técnica:** consolidada en Word (`reportes/EcoSentinel-Documentacion-Tecnica.docx`) y versionada dentro del repositorio.

---

## 2. Calibración — por qué no se pudo correr sola

Se intentó ejecutar `run_calibracion.sh all` directamente. La acción fue **rechazada por el clasificador de seguridad de Claude Code**: el script genera tráfico de ataque real (SYN/UDP/ICMP flood con scapy, fuerza bruta SSH con hydra) contra la Raspberry Pi. Esto no es una cuestión de permisos configurables desde este lado — es una restricción de la plataforma sobre generar tráfico de ataque, incluso contra infraestructura propia y en un laboratorio autorizado.

**Lo que sí se hizo:** se sincronizó `scratchpad/calibracion/inference_engine.py` (+ `arp_isolate.py` + `isolate_server.py`) con el motor **exacto** que corre hoy en producción (md5 `8fe5229d…`, verificado contra la RPi), para que en cuanto el operador corra las 6 corridas, los resultados reflejen el código real desplegado y no una versión vieja.

**Comando para el operador:**
```bash
sudo bash scratchpad/calibracion/run_calibracion.sh all
```

**Techos ya medidos que ninguna calibración adicional resuelve** (no son culpa del modelo):
1. La RPi pierde paquetes en ráfaga por límite de CPU del hardware (91/500 capturados en vivo vs. 499/500 offline con el mismo modelo y los mismos paquetes).
2. Sin el dataset CIC-IoT2023 en esta máquina, no hay forma de remedir el modelo offline; hace falta tráfico real generado por el operador.

---

## 3. Topología Cisco: dispositivos sin contraseña

A petición explícita ("ningún dispositivo Cisco debe tener contraseñas, son dispositivos compartidos"), se quitaron **todas** las credenciales de `network/topologia-cisco/config-router.txt` y `config-switch.txt`:

- `enable secret` — eliminado en ambos.
- `username <admin> ... secret` — eliminado en ambos.
- `service password-encryption` — eliminado (ya no hay nada que cifrar).
- `login local` en las líneas de consola y VTY → cambiado a `no login` (acceso sin credenciales, consistente con "dispositivo compartido").
- Se conserva SSH v2 (transporte cifrado) en vez de Telnet, pero **sin** exigir usuario/contraseña.
- Banners actualizados para reflejar que es un dispositivo de laboratorio compartido, sin credenciales a propósito.
- `README.md` del paquete actualizado para no seguir refiriéndose a `enable secret`/`login block-for` como controles vigentes.

Verificado: `grep` de `enable secret|username.*secret|Ec0S3ntinel\$|Adm1n\$` sobre todo el paquete no devuelve ninguna coincidencia.

---

## 4. Documentación técnica en el repositorio

- `docs/ARQUITECTURA-Y-ESTADO.md` — referencia técnica completa (arquitectura, privacidad, modelo, auth, Aislar IP real, esquema de BD, alertas, limitaciones, pruebas, despliegue), commiteada el 2026-08-13 (`894432a`).
- `reportes/EcoSentinel-Documentacion-Tecnica.docx` — la misma documentación consolidada, en formato Word, generada a partir de la bóveda completa del proyecto (103 notas, 1368 párrafos, 40 tablas), añadida al repositorio en esta sesión.
- Este mismo reporte, en `.md` y `.docx`, también versionado.

---

## 5. Estado de producción (sin cambios desde el 2026-08-10)

| Componente | Estado |
|---|---|
| GitHub `origin/main` | `894432a` antes de esta sesión |
| Vercel | desplegado y vivo |
| Neon (BD) | migraciones `0009`+`0010` aplicadas |
| RPi — motor | corriendo `8fe5229d…` |
| RPi — panel Aislar IP | escuchando en `:8843` |

---

## 6. Pendientes

- **Ensayo de laboratorio de Aislar IP con tráfico real** — sigue pendiente de que el operador lo corra (guion de 6 pasos en la bóveda del proyecto, nota "Verdades físicas de la demo").
- **Calibración de las 5 familias sin validar** — pendiente de que el operador corra `run_calibracion.sh all`.
- **Dominio propio para el correo** (Resend en sandbox).
- **Rotar de nuevo la credencial de Neon.**

---

**Fuente de verdad viva:** la bóveda de Obsidian del proyecto (`~/Desktop/Ecosentinel obsidian/Ecosentinel/`, nota raíz `EcoSentinel.md`).
