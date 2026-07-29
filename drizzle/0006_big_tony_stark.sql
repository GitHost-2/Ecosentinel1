CREATE TABLE IF NOT EXISTS "mitigations" (
	"id" serial PRIMARY KEY NOT NULL,
	"detection_id" integer NOT NULL,
	"device_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mitigations" ADD CONSTRAINT "mitigations_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mitigations" ADD CONSTRAINT "mitigations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mitigations_detection_id_idx" ON "mitigations" USING btree ("detection_id");