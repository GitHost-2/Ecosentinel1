-- EcoSentinel — script único para crear toda la estructura de la base de datos.
-- Pégalo tal cual en el SQL Editor de Neon (o en psql) una sola vez.
-- Es el mismo contenido que genera `npm run db:migrate` a partir de db/schema.ts,
-- consolidado aquí para que lo puedas correr manualmente si prefieres no usar la CLI.

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

CREATE TABLE IF NOT EXISTS "devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre_cliente" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"fecha_alta" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text DEFAULT 'Pro' NOT NULL
);

CREATE TABLE IF NOT EXISTS "detections" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"attack_prob" real NOT NULL,
	"protocol" text NOT NULL,
	"attack_type" text NOT NULL,
	"src_ip_hash" text NOT NULL,
	"dst_port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "detections_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "device_heartbeats" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"cpu_pct" real NOT NULL,
	"ram_pct" real NOT NULL,
	"modelo_version" text NOT NULL,
	CONSTRAINT "device_heartbeats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE
);

-- Índices útiles para las queries que usa el dashboard (feed de alertas,
-- gráfico de 24h y distribución de amenazas por tipo).
CREATE INDEX IF NOT EXISTS "detections_timestamp_idx" ON "detections" ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "detections_device_id_idx" ON "detections" ("device_id");
CREATE INDEX IF NOT EXISTS "device_heartbeats_device_id_idx" ON "device_heartbeats" ("device_id");
