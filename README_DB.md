# Conexión a base de datos (Postgres / Neon) — EcoSentinel

Este documento explica, paso a paso, cómo pasar el dashboard de EcoSentinel
de datos simulados a una base de datos Postgres real, usando Neon +
Vercel, y qué archivos cambiaron para lograrlo.

## Qué cambió (resumen técnico)

El repo era un sitio estático (HTML/CSS/JS puro servido con `serve`), sin
backend. Para poder consultar una base de datos de forma segura (nunca
desde el navegador) fue necesario migrarlo a **Next.js (App Router)**:

- `public/index.html` y `public/dashboard.html` ahora se sirven desde
  `app/page.tsx` y `app/dashboard/page.tsx` (el HTML es el mismo, solo se
  movió; el CSS y los scripts `animations.js` / `auth.js` / `dashboard.js`
  siguen viviendo sin cambios de comportamiento en `public/css` y
  `public/js`, excepto `dashboard.js`, que ahora pide sus datos a la API
  en vez de generarlos con `Math.random()`).
- Se agregó `db/schema.ts` (esquema de Drizzle ORM) con 4 tablas:
  `devices`, `detections` (se le sumó una columna `attack_type` que no
  estaba en el pedido original, porque la UI necesita la familia de
  ataque — Ransomware/DDoS/etc — y `protocol` por sí solo no alcanza para
  reconstruirla), `device_heartbeats` y `users` (cuentas del landing:
  empresa, correo, contraseña hasheada, plan, perfil del cuestionario).
- Se agregaron 4 endpoints de datos (`app/api/stats`, `/api/alerts`,
  `/api/hourly`, `/api/threats`) que reemplazan, uno por uno, cada bloque
  de mock data que antes vivía en `public/js/dashboard.js`.
- Se agregaron 3 endpoints de auth (`app/api/auth/register`,
  `/api/auth/login`, `/api/auth/profile`) y se conectó `public/js/auth.js`
  a ellos: el registro/login ya no es una simulación pura de front-end,
  las cuentas se guardan en la tabla `users` con la contraseña hasheada
  (bcrypt). La sesión en `sessionStorage` del navegador sigue existiendo,
  pero ahora es solo una copia local de conveniencia para que
  `dashboard.js` sepa quién entró — el dato real vive en Postgres.
- El feed de "alertas en vivo" que aparece después de la carga inicial
  sigue siendo una simulación visual client-side (todavía no hay eventos
  reales de la Raspberry Pi) — no escribe en la base de datos. Cuando la
  RPi esté lista, ese es el punto (`connectLive()`, al final de
  `dashboard.js`) donde se conecta el WebSocket real.

## Paso 1 — Crear la base de datos en Neon

Tienes dos caminos, elige uno:

### Opción A (recomendada): integración nativa Vercel + Neon

1. Entra a tu proyecto en [vercel.com](https://vercel.com) (impórtalo desde
   este repo de GitHub si no lo has hecho).
2. Ve a la pestaña **Storage** del proyecto.
3. Elige **Neon** en el marketplace de integraciones y sigue el asistente
   ("Create Database").
4. Vercel crea el proyecto en Neon y **define automáticamente** la
   variable de entorno `DATABASE_URL` en tu proyecto de Vercel (Production,
   Preview y Development). No necesitas copiar/pegar ninguna connection
   string ahí.

### Opción B: crear la cuenta en Neon manualmente

1. Crea una cuenta en [neon.tech](https://neon.tech).
2. Crea un proyecto nuevo (elige la región más cercana a tus usuarios).
3. En el dashboard de Neon, ve a **Connect** y copia la connection string
   en modo **pooled** (el host contiene `-pooler`), algo como:
   `postgresql://usuario:password@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require`
4. En Vercel, ve a **Project Settings -> Environment Variables** y crea
   `DATABASE_URL` con ese valor (para Production, Preview y Development).

## Paso 2 — Configurar tu entorno local

1. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Pega ahí la misma connection string de Neon (la de Vercel -> Storage ->
   Neon -> `.env.local` tab, o la que copiaste en la Opción B).
3. Instala dependencias (el repo trae `package-lock.json`, usa npm):
   ```bash
   npm install
   ```

## Paso 3 — Crear las tablas

Ya vienen generadas las migraciones a partir de `db/schema.ts`:
`drizzle/0000_smooth_menace.sql` (devices/detections/device_heartbeats) y
`drizzle/0001_grey_kingpin.sql` (users). Para aplicarlas a tu base de Neon:

```bash
npm run db:migrate
```

Si ya habías creado las tablas a mano pegando el SQL en el editor de Neon
(sin pasar por `db:migrate`), solo te falta la tabla nueva `users`. Pega
esto en el **SQL Editor de Neon**:

```sql
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"plan" text DEFAULT 'Pro' NOT NULL,
	"profile" text DEFAULT 'intermedio' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
```

Si en el futuro modificas `db/schema.ts`, genera una migración nueva y
aplícala:

```bash
npm run db:generate   # crea un nuevo archivo en drizzle/
npm run db:migrate    # lo aplica
```

(Alternativa rápida para prototipos: `npm run db:push` sincroniza el
esquema directo a la base sin generar archivos de migración. Para este
proyecto, usa `db:migrate` para que quede un historial versionado.)

## Paso 4 — Poblar datos de ejemplo (seed)

Esto llena `devices`, `detections` y `device_heartbeats` con datos
realistas (mismo rango que el mock anterior: probabilidad 0.72-0.999, 6
familias de ataque con las mismas proporciones que mostraba la dona, ~14
días de historial) para que el dashboard se vea igual que antes mientras
se conecta la Raspberry Pi real:

```bash
npm run db:seed
```

## Paso 5 — Correr el proyecto

```bash
npm run dev
```

Abre `http://localhost:3000` (landing) y `http://localhost:3000/dashboard`
(inicia sesión o entra directo a `/dashboard`, la sesión sigue siendo
simulada vía `sessionStorage` como antes).

## Cómo consultar los usuarios registrados

Desde el **SQL Editor de Neon** (o cualquier cliente Postgres conectado con
tu `DATABASE_URL`):

```sql
-- Todos los usuarios (sin exponer el hash de la contraseña)
SELECT id, company, email, plan, profile, created_at
FROM users
ORDER BY created_at DESC;

-- Cuántos usuarios hay por plan
SELECT plan, count(*) FROM users GROUP BY plan;

-- Cuántos usuarios hay por perfil de conocimiento
SELECT profile, count(*) FROM users GROUP BY profile;
```

Nunca hace falta (ni conviene) hacer `SELECT password_hash` salvo para
depurar el propio backend — es un hash bcrypt, no la contraseña en texto
plano, así que no es legible de todas formas.

Si prefieres verlo desde código en vez de SQL, con Drizzle sería:
```ts
import { db } from "@/db";
import { users } from "@/db/schema";

const allUsers = await db
  .select({ id: users.id, company: users.company, email: users.email, plan: users.plan, profile: users.profile })
  .from(users);
```

## Conectar la Raspberry Pi (datos reales, no simulados)

Esto reemplaza el feed "en vivo" simulado por eventos reales del appliance.

### 1. Variable de entorno nueva: `INGEST_HMAC_SECRET`

Genera un secreto y agrégalo en Vercel (**Settings -> Environment
Variables**) y en tu `.env` local:
```bash
openssl rand -hex 32
```
Se usa para autenticar las API keys de cada dispositivo y para hashear
(HMAC) las IPs de origen antes de guardarlas — nunca se guarda la IP en
texto plano. Si este secreto cambia, todas las API keys ya emitidas dejan
de funcionar.

### 2. Da de alta la Raspberry Pi como dispositivo real

```bash
npm run db:create-device -- --cliente "Nombre del cliente" --plan Pro
```

Esto imprime una **API key en texto plano una sola vez** (la base de
datos solo guarda su hash, no se puede recuperar después). Cópiala a la
RPi — por ejemplo como variable de entorno `ECOSENTINEL_API_KEY` en el
script de inferencia.

### 3. Qué debe mandar la RPi por cada detección

`POST https://<tu-dominio-de-vercel>/api/ingest/detections`

Headers:
```
Authorization: Bearer <la API key del paso 2>
Content-Type: application/json
```

Body:
```json
{
  "attack_prob": 0.94,
  "attack_type": "Port Scanning",
  "protocol": "TCP",
  "src_ip": "192.168.1.57",
  "dst_port": 443,
  "timestamp": "2026-07-14T22:10:03Z"
}
```

- `attack_type` debe ser exactamente uno de: `Ransomware`, `DDoS`,
  `Port Scanning`, `Botnet Mirai`, `Brute Force`, `Spoofing`.
- `src_ip` va en texto plano en la petición (viaja cifrado por HTTPS); el
  servidor la hashea con HMAC antes de guardarla — la RPi nunca necesita
  hashear nada de su lado.
- `timestamp` es opcional (default: la hora del servidor al recibir la
  petición).

Ejemplo mínimo en Python (si tu script de inferencia ya está en Python):
```python
import requests

requests.post(
    "https://tu-dominio.vercel.app/api/ingest/detections",
    headers={"Authorization": "Bearer " + API_KEY},
    json={
        "attack_prob": prob,
        "attack_type": attack_type,
        "protocol": protocol,
        "src_ip": src_ip,
        "dst_port": dst_port,
    },
    timeout=5,
)
```

### 4. Heartbeats (salud del dispositivo)

`POST /api/ingest/heartbeat`, mismo header `Authorization`:
```json
{ "cpu_pct": 34.2, "ram_pct": 51.8, "modelo_version": "rf-v1.3", "packets_processed": 18234 }
```
`packets_processed` es opcional (default 0) y es el **delta desde el
heartbeat anterior**, no un contador acumulado — así un reinicio de la
RPi no rompe el total. `/api/stats` hace `SUM(packets_processed)` sobre
`device_heartbeats` para "Paquetes analizados"; ya no es una fórmula
inventada, es un dato real que reporta la RPi.

### 5. Cómo se ve reflejado en el dashboard

El dashboard ya no simula nada: `public/js/dashboard.js` hace *polling*
cada 6 segundos contra `/api/stats` y `/api/alerts` (y cada ~30s contra
`/api/hourly`, `/api/threats` y `/api/devices`). En cuanto la RPi manda
un evento real, aparece en el siguiente ciclo de polling — no hace falta
tocar el frontend para nada más.

El pill "Appliance conectado / desconectado" del header también es real:
sale de `/api/devices`, que marca un dispositivo `online` si mandó un
heartbeat hace menos de `ONLINE_THRESHOLD_MS` (3 minutos, ver
`app/api/devices/route.ts` — ajusta ese valor si la RPi termina mandando
heartbeats con otra frecuencia; hoy no hay un intervalo fijo definido del
lado de la RPi).

### 6. Varios dispositivos / varios clientes

Repite el paso 2 (`db:create-device`) por cada cliente/RPi. Cada uno
tiene su propia API key y sus propias filas en `detections` /
`device_heartbeats` vía `device_id`. El dashboard ya filtra por
dispositivo: el selector "Todos los dispositivos" en el header hace
`GET` con `?deviceId=<id>` contra `/api/stats`, `/api/alerts`,
`/api/hourly` y `/api/threats` (todos aceptan ese query param opcional).
La lista de dispositivos para el selector sale de `/api/devices`.

## Alertas por correo cuando hay un ataque

Cada vez que `/api/ingest/detections` guarda una detección real, intenta
(sin bloquear la respuesta a la RPi, vía `after()` de Next.js) mandarle
un correo al dueño del dispositivo. Máximo **1 correo cada 10 minutos
por dispositivo** — el resto se agrupa en silencio (ver
`lib/alerts.ts`); es la única forma de que una ráfaga de detecciones
(un ataque de volumen alto real, o un bug) no te llene la bandeja.

### 1. Variables de entorno nuevas

En Vercel (**Settings -> Environment Variables**) y en tu `.env` local:

```
RESEND_API_KEY=<tu api key de resend.com>
ALERT_FROM_EMAIL="EcoSentinel <alertas@tudominio.com>"   # opcional, default onboarding@resend.dev
DASHBOARD_URL=https://tu-dominio.vercel.app/dashboard    # opcional, default hardcodeado en lib/email.ts
```

Crea una cuenta gratis en [resend.com](https://resend.com). **Importante**:
sin verificar un dominio propio en Resend, el modo sandbox solo entrega
correos a la dirección con la que te registraste ahí — no le va a
llegar a tus clientes reales hasta que verifiques un dominio (Resend ->
Domains -> Add Domain, agregar los registros DNS que te da).

### 2. Ligar un dispositivo a la cuenta que debe recibir sus alertas

`devices.owner_user_id` (nuevo, nullable) apunta a `users.id`. Un
dispositivo sin dueño asignado nunca manda alertas (se salta en
silencio, sin loggear nada).

Para un dispositivo nuevo:
```bash
npm run db:create-device -- --cliente "Nombre del cliente" --plan Pro --owner-email dueno@empresa.com
```

Para uno que ya existe, desde el SQL Editor de Neon:
```sql
UPDATE devices SET owner_user_id = (SELECT id FROM users WHERE email = 'dueno@empresa.com') WHERE id = <id_del_dispositivo>;
```

### 3. Auditoría de alertas enviadas

`alert_log` guarda cada correo que realmente se mandó (no los que se
agruparon por el límite de frecuencia, ni los que fallaron):
```sql
SELECT a.sent_at, d.nombre_cliente, a.recipient_email
FROM alert_log a JOIN devices d ON d.id = a.device_id
ORDER BY a.sent_at DESC LIMIT 50;
```

## Notas y decisiones a revisar

- **`attack_type`**: se agregó a `detections` aunque no estaba en el
  esquema que pediste, porque sin ella no hay forma de reconstruir
  "Ransomware / DDoS / Port Scanning / Botnet Mirai / Brute Force /
  Spoofing" en la UI (`protocol` es la capa de red — TCP/UDP/ICMP — algo
  distinto). Si prefieres otro nombre de columna o modelarlo distinto,
  dímelo y lo ajusto.
- **`src_ip_hash`**: en el seed de ejemplo contiene strings con forma de
  IP (p. ej. `185.220.14.203`), no un hash real, porque son datos
  sintéticos — es solo para que el dashboard tenga algo que mostrar antes
  de conectar la RPi. En producción, `/api/ingest/detections` ya calcula
  el hash real: recibe `src_ip` en texto plano (viaja cifrado por HTTPS)
  y lo hashea con HMAC-SHA256 (`hashSourceIp()` en `lib/device-auth.ts`,
  usando `INGEST_HMAC_SECRET`) antes de insertar — la IP en texto plano
  nunca toca la base de datos.
- **"Paquetes analizados"**: resuelto — `device_heartbeats.packets_processed`
  (migración `0003_mean_mindworm.sql`) guarda el delta real que reporta
  cada heartbeat, y `/api/stats` hace `SUM()` sobre esa columna. Ya no
  hay ninguna fórmula inventada. Si no hay heartbeats con datos reales
  todavía, el número es honestamente 0.
- **`attack_type` es una HEURÍSTICA, no una clasificación del modelo**:
  el modelo real desplegado en la RPi (`ecosentinel_model_rpi.pkl`) es
  un `RandomForestClassifier` **binario** (`classes_ = [0, 1]`, solo
  ataque/no-ataque con una probabilidad) — no existe un clasificador de
  las 6 familias. `inference_engine.py` (parche pendiente de revisión,
  no aplicado aún a la RPi en producción) deriva `attack_type` con
  reglas de protocolo/puerto/patrón de flujo (`heuristic_attack_type()`)
  como aproximación honesta mientras no exista un modelo multiclase real
  entrenado. CIC-IoT2023 (el dataset de entrenamiento) tampoco tiene una
  categoría "Ransomware" propiamente — es tráfico de red de IoT, sin
  señal de cifrado de archivos.
- **Dos lockfiles**: el repo tenía `package-lock.json` y `pnpm-lock.yaml`
  a la vez. Se eliminó `pnpm-lock.yaml` y se regeneró `package-lock.json`
  con `npm install`, para no ambigüedad. Si usas pnpm, corre
  `pnpm install` para regenerar su lockfile en su lugar.
- Se eliminó el `index.html` de la raíz del repo (era el loader estático
  que redirigía a `public/index.html` para el servidor `serve`); ya no
  hace falta porque Next.js sirve `/` directamente con `app/page.tsx`.

## Variables de entorno en producción (Vercel)

Si usaste la integración nativa (Opción A), no tienes que hacer nada más:
`DATABASE_URL` ya está configurada en Vercel. Solo asegúrate de correr
`npm run db:migrate` (o `db:push`) y `npm run db:seed` **una vez**, ya sea
desde tu máquina local apuntando a la `DATABASE_URL` de producción, o
como un paso manual — Vercel no corre migraciones automáticamente en cada
deploy.
