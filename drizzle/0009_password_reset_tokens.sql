-- Tokens de "olvidé mi contraseña" (app/api/auth/forgot y app/api/auth/reset).
--
-- Escrita A MANO, no con `drizzle-kit generate`, para no chocar con la
-- numeración de otra migración en curso (0010). Por eso tampoco hay
-- `drizzle/meta/0009_snapshot.json`: si un `drizzle-kit generate` posterior
-- vuelve a emitir este CREATE TABLE, no rompe nada — todo aquí es idempotente
-- (`IF NOT EXISTS` y el `DO $$ ... duplicate_object` de las FK, el mismo
-- patrón replayable de la 0006 y la 0007).
--
-- La columna es `token_hash`: el token crudo NUNCA se guarda.
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");
