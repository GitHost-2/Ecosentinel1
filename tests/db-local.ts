/**
 * Puente para correr las rutas REALES contra el Postgres LOCAL de pruebas.
 *
 * Se importa PRIMERO (antes que `db/` o cualquier ruta), igual que
 * `setup-env`: tsx compila a CommonJS, así que los imports se ejecutan en
 * orden y los efectos de este módulo quedan aplicados antes de que
 * `db/index.ts` construya el cliente.
 *
 * ¿Por qué hace falta? `db/index.ts` usa `@neondatabase/serverless` en modo
 * HTTP, que habla con un proxy de Neon por HTTPS; un Postgres local no
 * entiende ese protocolo. En vez de falsear `db` (lo que probaría el falso y
 * no el SQL de verdad), aquí se sustituye SOLO el transporte:
 * `neonConfig.fetchFunction` es un punto de extensión oficial del driver
 * (ver CONFIG.md del paquete).
 *
 * Resultado: la ruta usa el mismo `db`, el mismo drizzle y el mismo SQL; lo
 * único que cambia es que los bytes van a 127.0.0.1:5432 en vez de a Neon.
 * Así las pruebas ven la semántica REAL de Postgres -- tipos `real`/float4,
 * índices únicos, concurrencia -- que es justo lo que hay que validar en
 * "Aislar IP".
 *
 * Protocolo emulado (leído de node_modules/@neondatabase/serverless):
 *   petición  -> POST con body JSON `{ query, params }`
 *   respuesta -> `{ fields: [{name, dataTypeID}], rows, command, rowCount }`
 * con las cabeceras `Neon-Raw-Text-Output: true` (los valores viajan como
 * texto crudo y los parsea el cliente) y `Neon-Array-Mode: true` (cada fila
 * es un arreglo). Por eso abajo se pide `rowMode: "array"` y se desactiva el
 * parseo de tipos de `pg`: quien parsea es el propio driver de Neon.
 */
import pg from "pg";
import { neonConfig } from "@neondatabase/serverless";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://ecosentinel:ecosentinel_local@127.0.0.1:5432/ecosentinel_test";

// Se fijan ANTES de que se importe `db/` o `lib/session` (ambos lanzan si
// faltan). Asignación directa, no `??=`: aquí sí queremos la base local.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.INGEST_HMAC_SECRET ??= "secreto-de-prueba-no-usar-en-produccion";

// Identidad: devolver el texto crudo tal cual para que lo parsee Neon.
const RAW_TEXT = { getTypeParser: () => (value: unknown) => value };

// Pool (no Client) a propósito: la prueba de concurrencia necesita varias
// conexiones de verdad en paralelo, igual que el HTTP de Neon, donde cada
// consulta es independiente y sin transacción compartida.
export const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 12 });

/** Campos de error que el driver de Neon copia de una respuesta 400. */
const PG_ERROR_FIELDS = [
  "severity", "code", "detail", "hint", "position", "internalPosition",
  "internalQuery", "where", "schema", "table", "column", "dataType",
  "constraint", "file", "line", "routine",
] as const;

neonConfig.fetchFunction = async (_url: string, init: { body: string }) => {
  const payload = JSON.parse(init.body) as { query: string; params: unknown[] };
  try {
    const result = await pool.query({
      text: payload.query,
      values: payload.params,
      rowMode: "array",
      types: RAW_TEXT as never,
    });
    const body = {
      command: result.command,
      rowCount: result.rowCount,
      rowAsArray: true,
      fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: result.rows,
    };
    return { ok: true, status: 200, json: async () => body };
  } catch (error) {
    const e = error as Record<string, unknown> & { message: string };
    const body: Record<string, unknown> = { message: e.message };
    for (const field of PG_ERROR_FIELDS) body[field] = e[field];
    return { ok: false, status: 400, json: async () => body, text: async () => e.message };
  }
};

/**
 * ¿Hay Postgres local escuchando y con el esquema puesto? Si no, las pruebas
 * que tocan base se SALTAN (con motivo visible) en vez de fallar, para que
 * `npm test` siga corriendo en una máquina sin Postgres.
 */
export async function databaseUnavailableReason(): Promise<string | false> {
  try {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
    await client.connect();
    const { rows } = await client.query(
      "select count(*)::int as n from information_schema.tables where table_schema='public' and table_name in ('users','devices','detections','mitigations')",
    );
    await client.end();
    return rows[0].n === 4 ? false : "la base local no tiene el esquema (corre: npm run db:push)";
  } catch (error) {
    return `no hay Postgres local en ${TEST_DATABASE_URL.replace(/:[^:@]*@/, ":***@")} (${(error as Error).message})`;
  }
}

export async function closePool() {
  await pool.end();
}
