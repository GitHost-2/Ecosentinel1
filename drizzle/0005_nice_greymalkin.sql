ALTER TABLE "alert_log" RENAME COLUMN "recipient_email" TO "recipient";--> statement-breakpoint
DROP INDEX IF EXISTS "alert_log_device_id_sent_at_idx";--> statement-breakpoint
ALTER TABLE "alert_log" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_log_device_id_channel_sent_at_idx" ON "alert_log" USING btree ("device_id","channel","sent_at");