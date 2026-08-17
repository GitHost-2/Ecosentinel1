-- Coautoría de dispositivos: pasa `owner_user_id` (uno) a muchos-a-muchos.
-- Decisión de negocio del 2026-08-16: el dispositivo de demo se comparte, no
-- es "un dispositivo por cliente" -- cualquier cuenta nueva registrada queda
-- coautora de todos los dispositivos existentes, con las mismas acciones que
-- el dueño original (ver app/api/auth/register/route.ts).
--
-- Escrita a mano, como la 0009 y la 0010 (mismo patrón replayable:
-- IF NOT EXISTS + DO $$ ... duplicate_object para las FK).
CREATE TABLE IF NOT EXISTS "device_owners" (
	"device_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_owners_device_id_user_id_pk" PRIMARY KEY("device_id","user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_owners" ADD CONSTRAINT "device_owners_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_owners" ADD CONSTRAINT "device_owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_owners_user_id_idx" ON "device_owners" USING btree ("user_id");
--> statement-breakpoint
-- Backfill: el dueño original de cada dispositivo ya existente queda como
-- primer coautor (no pisa filas si esta migración se reaplica).
INSERT INTO "device_owners" ("device_id", "user_id")
SELECT "id", "owner_user_id" FROM "devices" WHERE "owner_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Backfill: cada usuario YA registrado antes de este cambio también queda
-- coautor de TODOS los dispositivos existentes (mismo criterio que se aplica
-- a los registros nuevos desde ahora -- ver app/api/auth/register/route.ts).
INSERT INTO "device_owners" ("device_id", "user_id")
SELECT d."id", u."id" FROM "devices" d CROSS JOIN "users" u
ON CONFLICT DO NOTHING;
