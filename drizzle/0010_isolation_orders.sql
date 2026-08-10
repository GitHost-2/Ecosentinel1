-- Cola de órdenes de aislamiento REAL (corte por ARP spoofing en la RPi).
-- Ver rpi/arp_isolate.py y app/api/mitigate/{isolate,lift,pending,ack}.
--
-- Escrita a mano, como la 0009 (mismo patrón replayable: IF NOT EXISTS +
-- DO $$ ... duplicate_object para la FK), para no chocar con la numeración
-- de otra migración en curso.
CREATE TABLE IF NOT EXISTS "isolation_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"src_ip_hash" text NOT NULL,
	"detection_id" integer,
	"desired" text NOT NULL,
	"applied" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"requested_by_user_id" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "isolation_orders_device_hash_idx" ON "isolation_orders" USING btree ("device_id","src_ip_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "isolation_orders_device_applied_idx" ON "isolation_orders" USING btree ("device_id","applied");
