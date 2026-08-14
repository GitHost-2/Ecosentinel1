# EcoSentinel — Arquitectura y estado del sistema

Documento técnico consolidado, versionado junto al código. Complementa
`docs/base-de-datos.md` (que cubre solo la migración a Postgres). Este cubre
el sistema completo: qué hace cada pieza, cómo se relacionan, qué está
medido y qué sigue pendiente. Última actualización: **2026-08-13**.

## 1. Qué es

Appliance de ciberseguridad Edge AI: una Raspberry Pi 3A+ analiza el tráfico
de la red del cliente con un modelo de machine learning y detecta ataques en
tiempo real, sin que ningún dato identificable salga del dispositivo en
texto plano. El panel web (este repo) muestra las detecciones, gestiona
cuentas por suscripción, y ofrece aislar la IP de un atacante.

## 2. Componentes

```
┌─────────────────┐      HTTPS (Bearer API key)     ┌──────────────────┐      ┌─────────────┐
│  Raspberry Pi    │ ───────────────────────────────▶│  Next.js API     │─────▶│ Neon        │
│  3A+ (rpi/)      │◀─────────────────────────────── │  (Vercel)        │      │ Postgres    │
│  inference_engine│   GET /api/mitigate/pending      │  app/api/*       │      └─────────────┘
│  arp_isolate.py  │   POST /api/mitigate/ack         └──────────────────┘
│  isolate_server  │                                          │
└─────────────────┘                                          │ HTTPS
        │ HTTP local (LAN, con token)                         ▼
        ▼                                              ┌──────────────────┐
┌─────────────────┐                                    │  Dashboard web   │
│ Panel :8843      │◀── navegador del operador ────────│  (sesión HMAC)   │
│ (confirmar aislar)│                                   └──────────────────┘
└─────────────────┘
```

- **`rpi/inference_engine.py`** — captura de paquetes (scapy `sniff`),
  extracción de features, clasificación (RandomForest binario), envío de
  detecciones/heartbeats a la API, detección de barridos ARP.
- **`rpi/arp_isolate.py`** / **`rpi/isolate_server.py`** — corte real de IP
  por ARP spoofing y el panel HTTP local de confirmación (ver §6).
- **API (`app/api/`)** — Next.js App Router, desplegado en Vercel. Ingesta,
  autenticación, datos del dashboard, aislamiento.
- **Base de datos** — Neon Postgres (driver `neon-http`), esquema en
  `db/schema.ts`, migraciones en `drizzle/`.
- **Frontend** — landing (`app/page.tsx` + `app/_fragments/landing.html`) y
  dashboard (`app/dashboard/page.tsx` + `app/_fragments/dashboard.html`),
  HTML servido vía `dangerouslySetInnerHTML` + JS vanilla en `public/js/`.

## 3. El pilar de privacidad: "zero cloud, IP nunca en claro"

La IP de origen de cada detección se hashea **en la propia RPi**
(`hash_ip()`, HMAC-SHA256 con `.device_salt`, 32 bytes, `chmod 600`, generado
una vez y que nunca sale del dispositivo). El backend aplica una **segunda**
capa de HMAC antes de guardar (`lib/device-auth.ts` → `hashSourceIp`). Un
`sha256(ip)` simple sería reversible por fuerza bruta sobre el espacio de
IPv4 (~4.3 mil millones); por eso HMAC con clave secreta.

Esto no es solo una nota de diseño: **condiciona la arquitectura completa
del aislamiento real** (§6) — la confirmación con la IP visible tiene que
vivir en la RPi, no en el dashboard, porque el dashboard nunca tiene esa IP.

## 4. Modelo de detección

- RandomForest **binario** (ataque / no ataque), entrenado sobre
  CIC-IoT2023, 30 features. `entrenamiento/scripts/`.
- Umbral efectivo en producción: **0.95** (`DETECTION_THRESHOLD_FLOOR`
  sobreescribe el 0.10 calibrado del `.pkl`, que asumía que el ataque es la
  clase mayoritaria — no es el caso en tráfico real).
- La "familia" que se muestra (Ransomware/DDoS/Port Scanning/etc.) es una
  **heurística por puerto/protocolo** (`heuristic_attack_type()`), NO una
  salida del modelo — el modelo es estrictamente binario.
- **Validado empíricamente: solo *port scanning*** (nmap -sS real, 499/500
  flujos detectados offline; 91/500 en vivo por límite de captura del
  hardware bajo ráfaga, no del modelo — ver §9). Las otras cinco familias
  tienen arnés de calibración listo (`rpi/` copiado a un rig aislado) pero
  requieren tráfico de ataque real generado por un operador humano.

## 5. Autenticación y sesiones

- Cookies de sesión firmadas con HMAC (`lib/session.ts`), `HttpOnly` +
  `Secure` + `SameSite=Lax`, 7 días, comparación en tiempo constante.
- Dispositivos autenticados por `Authorization: Bearer <api_key>`
  (`lib/device-auth.ts`), hash de la key en `devices.api_key_hash`.
- Scoping por dueño en **todas** las rutas de datos (`devices.owner_user_id`).
- Recuperar contraseña por correo: `/forgot` + `/reset`, token de un solo
  uso (SHA-256, nunca el crudo), TTL 1h, reclamo atómico
  (`UPDATE ... WHERE used_at IS NULL`), respuesta anti-enumeración.
- Cambiar contraseña con sesión abierta: `POST /api/auth/change-password`,
  exige la contraseña actual (`bcrypt.compare`) antes de aplicar la nueva.

## 6. Aislar IP — corte real por ARP spoofing

La RPi es cliente WiFi *managed*: no está en línea en la red, no puede
enrutar ni dropear tráfico unicast ajeno. El único mecanismo real desde su
posición es **envenenar el ARP** del atacante y del gateway en ambas
direcciones — la RPi no reenvía nada, así que el tráfico cae en un agujero
negro. Implementado en `rpi/arp_isolate.py` (clase `ArpIsolator`).

**Flujo end-to-end** (backend nunca ve la IP real, solo su hash):

1. Dashboard → `POST /api/mitigate/isolate` → crea una fila en
   `isolation_orders` (`desired='isolated'`, `applied='pending'`, solo el
   hash).
2. La RPi sondea `GET /api/mitigate/pending` cada 5s (`isolate_server.py`).
3. Resuelve el hash contra `IP_MEMORY` — un mapa local **efímero** (TTL 15
   min, tope 500 entradas) que se llena en el instante en que
   `send_detection()` calcula ese mismo hash. Si ya no está, la orden se
   marca `failed` con una nota — nunca se inventa la IP.
4. Si resuelve, queda pendiente de confirmar en el **panel HTTP local**
   (`http://<rpi>:8843/`, protegido por token) — el único lugar donde esa IP
   existe en texto plano. Ahí se muestra la IP real + el dispositivo
   identificado (fabricante por OUI de la MAC, hostname por PTR inverso,
   mejor esfuerzo, nunca inventado).
5. El operador confirma **dos veces** (clic + diálogo del navegador
   repitiendo la IP) — la única acción de todo el sistema que pide más de
   una confirmación.
6. `ArpIsolator.start()` ejecuta el corte; `POST /api/mitigate/ack` reporta
   el resultado al backend (sin la IP).

Liberar (`/api/mitigate/lift`) es el mismo mecanismo al revés, pero la RPi
lo ejecuta **sin** pedir la segunda confirmación (revertir un corte es la
acción segura por defecto).

Existe también la guía manual histórica (`POST /api/mitigate`, tabla
`mitigations`) que sigue disponible en paralelo como respaldo si el corte
automático no aplica.

**Estado (2026-08-13):** código, pruebas (42 casos: `tests/isolation.test.ts`,
`tests/test_arp_isolate.py`, `tests/test_isolate_service.py`) y despliegue
completos y verificados en producción. Falta el ensayo con tráfico real de
ataque, que debe lanzarlo el operador desde un dispositivo que no sea el de
administración (ver `network/topologia-cisco/` y la nota de "verdades
físicas de la demo" en la bóveda del proyecto) — ni el clasificador de
seguridad del agente lo permite, ni la laptop de administración (excluida
del análisis por diseño) podría generar una detección aunque se permitiera.

## 7. Base de datos (Neon Postgres, `db/schema.ts`)

| Tabla | Migración | Para qué |
|---|---|---|
| `users` | `0000` | Cuentas (empresa/nombre, correo, contraseña, plan, perfil) |
| `devices` | `0000` | Appliances, `owner_user_id` |
| `detections` | `0000` | Detecciones (`id` es `serial`/int4 — ver nota abajo) |
| `mitigations` | — | Confirmaciones de la guía manual de aislar IP |
| `alert_log` | `0008` | Envíos de alertas, con `status` (`sent`/`failed`) |
| `rate_limit_counters` | `0007` | Contadores de rate limiting (ventana fija) |
| `device_heartbeats` | — | Heartbeats de la RPi |
| `password_reset_tokens` | `0009` | Reset de contraseña (solo hash del token) |
| `isolation_orders` | `0010` | Cola de aislamiento real (§6) |

`detections.id` es `serial` (int4): un id mayor al rango de int4 hacía que
Postgres abortara la consulta con 500 en vez de 400 — corregido validando el
techo explícitamente.

## 8. Alertas

Resend (correo) + Twilio WhatsApp (sandbox). Cooldown por dispositivo y por
canal (`alert_log`), 10 minutos tras un envío exitoso, ventana más corta tras
un fallo (para no perder alertas reales por un fallo transitorio, pero
tampoco reintentar sin parar contra un canal roto). Resend en modo sandbox
solo entrega al correo de la cuenta — sin dominio propio verificado, un
cliente real no recibe nada (pendiente de alta prioridad).

## 9. Limitaciones de diseño conocidas (no son bugs)

- **La RPi en WiFi *managed* solo ve su propio tráfico + broadcast.** Un
  ataque contra OTRO dispositivo le pasa desapercibido, salvo que sea
  reconocimiento por ARP (broadcast, sí se ve). Ver `network/topologia-cisco/`
  para la vía de diseño que sí cubriría tráfico ajeno (puerto SPAN en un
  switch gestionado).
- **Pérdida de paquetes en ráfaga:** la RPi captura 91/500 puertos de un
  escaneo en vivo (99.8% offline, mismo modelo) — límite de CPU del
  hardware, no del software.
- **Sin RTC:** la hora al arrancar puede quedar mal puesta hasta que NTP
  sincronice (~60s).
- **No hay RBAC**, solo scoping por dueño.

## 10. Pruebas

```bash
cd repo-web
npm test                     # 118 pruebas TypeScript
npx tsc --noEmit              # sin errores
python3 -m unittest tests.test_arp_detection tests.test_sender_resilience \
  tests.test_arp_isolate tests.test_isolate_service   # 46 pruebas Python (motor RPi)
```

Las pruebas de rutas corren contra un Postgres **local real** (no un doble):
`tests/db-local.ts` sustituye solo el transporte del driver de Neon
(`neonConfig.fetchFunction`), así que se ejercita el SQL real. Sin Postgres
local, esos casos se saltan con el motivo a la vista en vez de fallar.

## 11. Despliegue

- `git push` a `main` dispara el auto-deploy en Vercel (proyecto
  `ecosentinel1`, ya vinculado vía GitHub App).
- Las migraciones a Neon (producción) se aplican a mano — la connection
  string vive **solo** en Vercel (marcada *Sensitive*), nunca en el repo ni
  en variables locales.
- Actualizar el motor de la RPi requiere escribir en la capa persistente
  bajo el overlay de solo-lectura (`/media/root-ro`, remount temporal) y
  **reiniciar** — el remount a solo-lectura no funciona en caliente.

## 12. Topología de red Cisco

`network/topologia-cisco/` — alineada con el documento oficial de
Arquitectura de red de la escuela. VLANs segmentadas (10 admin / 20 usuarios
/ 30 IoT / 40 invitados / 99 gestión), un puerto **SPAN** (`Fa0/10`) que
espejea el tráfico de las VLANs de usuario hacia la RPi — la única forma de
que vea tráfico ajeno al suyo en un despliegue con switch gestionado en vez
de repetidor WiFi. Incluye router, switch, servidor DHCP
(`dhcp-server-ecosentinel.sh`) y un plan de pruebas de segmentación.

> ⚠️ `config-router.txt` y `config-switch.txt` llevan contraseñas de
> **laboratorio** en texto plano (`enable secret`, credenciales locales).
> Son credenciales de un ejercicio académico, no de infraestructura real;
> aun así, considerar reemplazarlas por placeholders antes de una entrega o
> publicación externa.

## 13. Registro de cambios reciente

- **2026-08-13** — Rig de calibración sincronizado con el motor actual;
  topología Cisco versionada en el repo; este documento.
- **2026-08-10** — Despliegue completo a producción (push, Vercel, Neon,
  motor de la RPi); "cambiar contraseña" con sesión abierta.
- **2026-08-09** — Recuperar contraseña por correo; mobile-friendliness;
  reposicionamiento a paquete/suscripción; Aislar IP con corte real por ARP;
  blindaje del hilo emisor.

Para el detalle sesión por sesión y las notas de diseño completas, ver la
bóveda de Obsidian del proyecto (fuente de verdad viva, fuera de este repo).
