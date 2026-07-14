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
