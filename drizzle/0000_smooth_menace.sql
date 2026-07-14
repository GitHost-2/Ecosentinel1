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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_heartbeats" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"cpu_pct" real NOT NULL,
	"ram_pct" real NOT NULL,
	"modelo_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre_cliente" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"fecha_alta" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text DEFAULT 'Pro' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "detections" ADD CONSTRAINT "detections_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_heartbeats" ADD CONSTRAINT "device_heartbeats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
