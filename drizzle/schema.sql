-- EcoSentinel — script único para crear toda la estructura de la base de datos.
-- Pégalo tal cual en el SQL Editor de Neon (o en psql) una sola vez.
--
-- POR QUÉ EXISTE ESTE ARCHIVO: las migraciones incrementales `0000`..`0010` NO
-- son replayables contra una base vacía (la `0003` y la `0004` duplican columnas
-- que la `0002` ya creó). Aplican bien de forma incremental — producción está
-- sana — pero para levantar un entorno NUEVO desde cero hay que usar esto.
--
-- Todo es idempotente (`IF NOT EXISTS` + el `DO $$ ... duplicate_object` de las
-- FK), así que correrlo dos veces no rompe nada.
--
-- Corresponde a `db/schema.ts` con las 9 tablas al día: users, devices,
-- detections, alert_log, mitigations, rate_limit_counters, device_heartbeats,
-- isolation_orders y password_reset_tokens.
--
-- Verificado el 2026-08-16 aplicándolo a una base vacía y comparando columnas e
-- índices contra la base de pruebas real (ver tests/db-local.ts).

-- ─────────────────────────────────────────────────────────────
-- users — cuentas del landing
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"email" text NOT NULL,
	-- E.164 (ej. +5215512345678). Nullable: sin él no hay alerta por WhatsApp.
	"phone" text,
	"password_hash" text NOT NULL,
	"plan" text DEFAULT 'Pro' NOT NULL,
	"profile" text DEFAULT 'intermedio' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

-- ─────────────────────────────────────────────────────────────
-- devices — el appliance físico (la RPi)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre_cliente" text NOT NULL,
	-- Nunca la API key en claro: solo su hash (lib/device-auth.ts).
	"api_key_hash" text NOT NULL,
	"fecha_alta" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text DEFAULT 'Pro' NOT NULL,
	"owner_user_id" integer
);

DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- authenticateDevice() busca por este hash en CADA request de ingesta.
CREATE UNIQUE INDEX IF NOT EXISTS "devices_api_key_hash_idx" ON "devices" USING btree ("api_key_hash");

-- ─────────────────────────────────────────────────────────────
-- detections — lo que reporta el motor. `src_ip_hash`, NUNCA la IP.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "detections" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"attack_prob" real NOT NULL,
	"protocol" text NOT NULL,
	"attack_type" text NOT NULL,
	"src_ip_hash" text NOT NULL,
	"dst_port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "detections" ADD CONSTRAINT "detections_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Para las queries por rango de /api/alerts, /api/hourly y /api/threats.
CREATE INDEX IF NOT EXISTS "detections_timestamp_idx" ON "detections" USING btree ("timestamp");
CREATE INDEX IF NOT EXISTS "detections_device_id_timestamp_idx" ON "detections" USING btree ("device_id","timestamp");

-- ─────────────────────────────────────────────────────────────
-- alert_log — auditoría y cooldown de alertas (lib/alerts.ts)
-- `status='failed'` también se registra: un canal averiado sin fila hacía que
-- el cooldown no lo frenara y se reintentara en CADA detección.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "alert_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"detection_id" integer,
	"channel" text DEFAULT 'email' NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "alert_log" ADD CONSTRAINT "alert_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "alert_log" ADD CONSTRAINT "alert_log_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "alert_log_device_id_channel_sent_at_idx" ON "alert_log" USING btree ("device_id","channel","sent_at");

-- ─────────────────────────────────────────────────────────────
-- mitigations — confirmación humana de "Aislar IP" (guía manual).
-- La cola del corte REAL es isolation_orders, más abajo.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "mitigations" (
	"id" serial PRIMARY KEY NOT NULL,
	"detection_id" integer NOT NULL,
	"device_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "mitigations" ADD CONSTRAINT "mitigations_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "mitigations" ADD CONSTRAINT "mitigations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Único: no repetir la guía dos veces sobre la misma detección.
CREATE UNIQUE INDEX IF NOT EXISTS "mitigations_detection_id_idx" ON "mitigations" USING btree ("detection_id");

-- ─────────────────────────────────────────────────────────────
-- rate_limit_counters — lib/rate-limit.ts. Vive en la base porque en Vercel
-- cada invocación puede correr en otro proceso: un contador en memoria no
-- limitaría nada.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "rate_limit_counters" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);

-- Para el DELETE de purga probabilística por ventana vencida.
CREATE INDEX IF NOT EXISTS "rate_limit_counters_window_start_idx" ON "rate_limit_counters" USING btree ("window_start");

-- ─────────────────────────────────────────────────────────────
-- device_heartbeats — salud del appliance (CPU/RAM/paquetes)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "device_heartbeats" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"cpu_pct" real NOT NULL,
	"ram_pct" real NOT NULL,
	"modelo_version" text NOT NULL,
	-- Delta desde el heartbeat anterior, no acumulado: así un reinicio del
	-- motor no rompe el total.
	"packets_processed" integer DEFAULT 0 NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "device_heartbeats" ADD CONSTRAINT "device_heartbeats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "device_heartbeats_device_id_timestamp_idx" ON "device_heartbeats" USING btree ("device_id","timestamp");

-- ─────────────────────────────────────────────────────────────
-- isolation_orders — cola del corte REAL por ARP spoofing (migración 0010).
-- La IP real NUNCA vive aquí: solo su hash. La RPi lo resuelve contra su mapa
-- local efímero; si ya expiró, marca `failed` con nota en vez de inventarla.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "isolation_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"src_ip_hash" text NOT NULL,
	"detection_id" integer,
	"desired" text NOT NULL,               -- 'isolated' | 'released'
	"applied" text DEFAULT 'pending' NOT NULL, -- 'pending'|'isolated'|'released'|'failed'
	"note" text,
	"requested_by_user_id" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);

DO $$ BEGIN
 ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Único por (dispositivo, hash): pedir aislar dos veces al mismo atacante
-- REABRE la orden en vez de duplicarla.
CREATE UNIQUE INDEX IF NOT EXISTS "isolation_orders_device_hash_idx" ON "isolation_orders" USING btree ("device_id","src_ip_hash");
-- Para que la RPi pida "dame lo pendiente de ESTE dispositivo" con índice.
CREATE INDEX IF NOT EXISTS "isolation_orders_device_applied_idx" ON "isolation_orders" USING btree ("device_id","applied");

-- ─────────────────────────────────────────────────────────────
-- password_reset_tokens — "olvidé mi contraseña" (migración 0009).
-- Guarda el SHA-256 del token, nunca el token que recibe el usuario.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- NULL = todavía sin usar. El reset lo reclama con un UPDATE condicional
	-- (`WHERE used_at IS NULL`): eso es lo que lo hace de UN SOLO uso incluso
	-- con dos peticiones simultáneas.
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");
