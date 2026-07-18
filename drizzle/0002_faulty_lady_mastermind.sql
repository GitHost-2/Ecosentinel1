CREATE INDEX IF NOT EXISTS "detections_timestamp_idx" ON "detections" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "detections_device_id_timestamp_idx" ON "detections" USING btree ("device_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_heartbeats_device_id_timestamp_idx" ON "device_heartbeats" USING btree ("device_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_api_key_hash_idx" ON "devices" USING btree ("api_key_hash");