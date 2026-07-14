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

## Notas y decisiones a revisar

- **`attack_type`**: se agregó a `detections` aunque no estaba en el
  esquema que pediste, porque sin ella no hay forma de reconstruir
  "Ransomware / DDoS / Port Scanning / Botnet Mirai / Brute Force /
  Spoofing" en la UI (`protocol` es la capa de red — TCP/UDP/ICMP — algo
  distinto). Si prefieres otro nombre de columna o modelarlo distinto,
  dímelo y lo ajusto.
- **`src_ip_hash`**: en el seed de ejemplo contiene strings con forma de
  IP (p. ej. `185.220.14.203`), no un hash real, porque son datos
  sintéticos. Cuando la Raspberry Pi empiece a mandar eventos reales, ese
  campo debe llenarse con un hash (por ejemplo SHA-256) de la IP real,
  calculado antes de insertar — nunca la IP en texto plano — para
  preservar la privacidad de los clientes de tus PyMEs. Ese punto de
  ingesta real todavía no existe (es la parte de "conectar la Raspberry
  Pi", fuera del alcance de esta sesión).
- **"Paquetes analizados"**: no hay una tabla de contadores de tráfico en
  el esquema pedido, así que por ahora `/api/stats` deriva ese número de
  forma determinística a partir del conteo de detecciones, solo para que
  la cifra se vea en el mismo rango que el mock anterior. Cuando la RPi
  reporte un contador real de paquetes (probablemente vía
  `device_heartbeats` o una tabla nueva), hay que reemplazar esa fórmula
  por la cifra real.
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
