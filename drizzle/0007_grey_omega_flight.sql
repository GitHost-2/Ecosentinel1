CREATE TABLE IF NOT EXISTS "rate_limit_counters" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_counters_window_start_idx" ON "rate_limit_counters" USING btree ("window_start");