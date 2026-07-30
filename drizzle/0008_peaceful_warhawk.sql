-- Registra también los intentos de alerta FALLIDOS, para que un canal averiado
-- tenga cooldown y no se reintente en cada detección.
-- El default 'sent' deja válidas las filas anteriores a esta columna (todas
-- ellas eran, por definición, envíos con éxito).
ALTER TABLE "alert_log" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'sent' NOT NULL;
