# EcoSentinel

Appliance de ciberseguridad Edge AI para PyMEs. Una Raspberry Pi 3A+ analiza el
tráfico de la red del cliente en tiempo real y detecta ataques con un modelo
RandomForest, sin mandar datos identificables a la nube.

**Pilar de diseño: "zero cloud, local privacy".** La IP de origen se hashea con
HMAC-SHA256 y una clave que nunca sale del dispositivo (`hash_ip()` en
`rpi/inference_engine.py`); el servidor le aplica una segunda capa de HMAC antes
de guardarla. La IP real nunca sale de la red del cliente.

Producción: https://ecosentinel1.vercel.app

## Estructura

```
app/                  Next.js (App Router)
  api/ingest/         <- la RPi manda aquí: detecciones y heartbeats (auth por API key)
  api/                lecturas del dashboard (exigen sesión, filtradas por dueño)
  dashboard/          panel del cliente
  _fragments/         HTML que sirven las páginas
db/                   esquema Drizzle + scripts de alta de dispositivos y seed
drizzle/              migraciones SQL
lib/                  sesión, auth de dispositivo, alertas (email/WhatsApp)
public/               CSS, JS del cliente, iconos
rpi/                  motor de inferencia que corre en la Raspberry Pi
docs/                 documentación detallada
```

## Arranque local

```bash
npm install
cp .env.example .env          # rellena DATABASE_URL e INGEST_HMAC_SECRET
npm run db:migrate            # o aplica drizzle/*.sql a mano
npm run dev
```

Detalle completo de la base de datos, alta de dispositivos, alertas por correo y
por WhatsApp: **[docs/base-de-datos.md](docs/base-de-datos.md)**.

## Cómo encaja todo

1. La RPi captura tráfico en `wlan0`, agrupa paquetes en flujos y extrae 30
   features (mismo orden que CIC-IoT2023, el dataset de entrenamiento).
2. Si el modelo supera el umbral, hashea la IP de origen y hace `POST` a
   `/api/ingest/detections` con su API key. Cada 60 s manda un heartbeat.
3. El backend guarda la detección y —fuera de la respuesta, sin añadir latencia—
   avisa al dueño del dispositivo por correo y/o WhatsApp, con un máximo de una
   alerta cada 10 minutos por dispositivo y por canal.
4. El dashboard consulta la API cada 6 s y solo ve los dispositivos de la cuenta
   que inició sesión.

## Umbral de detección

El `.pkl` entrenado trae un umbral de **0.10**, calibrado sobre el set de prueba
de CIC-IoT2023, donde el tráfico de ataque es la clase mayoritaria. En una red
real de PyME la tasa base de ataques es ~0, así que ese umbral marca casi todo
como ataque. Medido sobre tráfico real (2026-07-29): el modelo asigna
**0.774–0.869** a flujos benignos; un `nmap -sS` real puntuó **0.990**. Por eso
el motor aplica un piso de **0.95** (`DETECTION_THRESHOLD_FLOOR`), ajustable en
una corrida puntual con `--threshold`.

## Limitaciones conocidas

- **El modelo es binario**, solo da probabilidad de ataque. La familia que se
  muestra (Ransomware/DDoS/Port Scanning/…) la decide `heuristic_attack_type()`
  por protocolo y puerto — no es una salida del modelo.
- **La RPi no puede bloquear tráfico.** Es un cliente WiFi, no está en línea en
  la red, así que solo ve tráfico hacia/desde sí misma y broadcast. El botón
  "Aislar IP" registra la confirmación y da instrucciones para bloquear en el
  router; nunca actúa sobre la red por su cuenta.
- **Las migraciones no son replayables desde cero**: `0003` y `0004` fallan
  contra una base vacía porque duplican columnas que `0002` ya creó. Aplican bien
  de forma incremental sobre producción, pero para un entorno nuevo hay que
  saltarse esas dos o consolidarlas.
