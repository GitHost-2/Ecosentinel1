/**
 * Variables de entorno para las pruebas.
 *
 * Se importa PRIMERO en cada archivo de test: los módulos de `lib/` y `db/`
 * lanzan al importarse si faltan estos secretos, y en ESM los imports se
 * evalúan en orden, así que este tiene que ir arriba.
 *
 * DATABASE_URL es un valor de mentira a propósito: `neon()` solo parsea la
 * cadena al construirse y no abre conexión, y estas pruebas no tocan la base
 * (usan el store en memoria). Así el test suite corre sin Postgres.
 */
process.env.INGEST_HMAC_SECRET ??= "secreto-de-prueba-no-usar-en-produccion";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/ecosentinel_test";
