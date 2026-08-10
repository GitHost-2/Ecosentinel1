import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Rate limiting con ventana fija respaldado en Postgres.
 *
 * ¿Por qué en la base y no en memoria? En Vercel cada invocación puede correr
 * en un proceso distinto (y en otra región), así que un contador en memoria no
 * se comparte y no limita nada. La base es el único estado común que ya existe.
 *
 * Ventana FIJA, no deslizante: se paga un solo UPSERT por petición en vez de
 * guardar una fila por intento. El precio conocido es que en el borde de dos
 * ventanas se pueden colar hasta 2x el límite (los últimos N de una ventana y
 * los primeros N de la siguiente). Para frenar fuerza bruta e inundación de la
 * ingesta es suficiente; no pretende ser un limitador exacto.
 */

/** Store inyectable: permite probar la lógica sin base y el SQL contra Postgres. */
export interface RateLimitStore {
  /** Incrementa el contador de (key, windowStart) y devuelve el valor ya incrementado. */
  increment(key: string, windowStart: Date): Promise<number>;
}

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
  /** Inyectable en tests; por defecto la hora actual. */
  now?: Date;
  store?: RateLimitStore;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Peticiones restantes en la ventana actual (0 si ya se pasó). */
  remaining: number;
  /** Segundos hasta que se abra la siguiente ventana. Va en el header Retry-After. */
  retryAfterSeconds: number;
  count: number;
}

/** Inicio de la ventana fija que contiene `now`. */
export function windowStartFor(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Store real: un UPSERT atómico. `count = count + 1` lo evalúa Postgres dentro
 * de la fila bloqueada, así que dos peticiones simultáneas no se pisan (que es
 * justo el caso que importa: una inundación es concurrente por definición).
 */
export function postgresStore(database: typeof db = db): RateLimitStore {
  return {
    async increment(key: string, windowStart: Date): Promise<number> {
      const rows = await database.execute<{ count: number }>(sql`
        INSERT INTO rate_limit_counters (bucket_key, window_start, count)
        VALUES (${key}, ${windowStart.toISOString()}, 1)
        ON CONFLICT (bucket_key, window_start)
        DO UPDATE SET count = rate_limit_counters.count + 1
        RETURNING count
      `);
      // neon-http devuelve {rows}, node-postgres devuelve {rows} también, pero
      // drizzle puede entregar el array directamente según el driver.
      const list = Array.isArray(rows) ? rows : rows.rows;
      return Number(list[0]?.count ?? 1);
    },
  };
}

/** Store en memoria, solo para pruebas y para el fallback de fail-open. */
export function memoryStore(): RateLimitStore {
  const counters = new Map<string, number>();
  return {
    async increment(key: string, windowStart: Date): Promise<number> {
      const k = `${key}@${windowStart.toISOString()}`;
      const next = (counters.get(k) ?? 0) + 1;
      counters.set(k, next);
      return next;
    },
  };
}

export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const { key, limit, windowSeconds } = options;
  const now = options.now ?? new Date();
  const store = options.store ?? postgresStore();

  const windowStart = windowStartFor(now, windowSeconds);
  const count = await store.increment(key, windowStart);

  const windowEndMs = windowStart.getTime() + windowSeconds * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - now.getTime()) / 1000));

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
    count,
  };
}

/**
 * Igual que checkRateLimit pero no propaga errores de base: si la base falla,
 * PERMITE la petición (fail-open) y lo registra.
 *
 * Es una decisión deliberada: un fallo transitorio de Neon no debe dejar a los
 * clientes sin poder entrar ni, sobre todo, tirar la ingesta de detecciones —
 * perder la alerta de un ataque real es peor que dejar pasar tráfico durante la
 * caída. El coste es que un atacante que logre tumbar la base también anula el
 * limitador.
 */
export async function checkRateLimitSafe(options: RateLimitOptions): Promise<RateLimitResult> {
  try {
    return await checkRateLimit(options);
  } catch (err) {
    console.error(`[rate-limit] fallo al consultar el contador (se permite la petición) key=${options.key}:`, err);
    return { allowed: true, remaining: options.limit, retryAfterSeconds: 0, count: 0 };
  }
}

/**
 * IP del cliente detrás del proxy de Vercel.
 *
 * OJO: `x-forwarded-for` puede venir con varios valores si el cliente mandó el
 * suyo; Vercel APENDE la IP real al final, así que se toma el ÚLTIMO valor, no
 * el primero. Tomar el primero permitiría a cualquiera falsear su IP y saltarse
 * el límite mandando un x-forwarded-for inventado.
 */
export function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "desconocida";
}

/**
 * Límites en un solo lugar, sobrescribibles por variable de entorno.
 *
 * Los de ingesta están dimensionados con una medición real: un `nmap -sS` de
 * 500 puertos contra el sensor produce 499 detecciones en menos de 2 segundos
 * (validado el 2026-07-30 sobre pcap). Un límite "prudente" de 60/min tiraría
 * la evidencia de un ataque de verdad, así que se elige holgado a propósito:
 * frena la inundación sostenida de una API key filtrada, no la ráfaga legítima.
 * Un escaneo de los 65535 puertos SÍ chocaría con el límite — se perderían las
 * detecciones posteriores al primer minuto, pero el patrón ya quedó registrado
 * en las primeras ~1200 (y la alerta ya salió).
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const LIMITS = {
  /** Login por IP: freno principal de fuerza bruta. */
  loginPerIp: { limit: envInt("RL_LOGIN_IP_LIMIT", 10), windowSeconds: 15 * 60 },
  /**
   * Login por correo: cubre el ataque distribuido (muchas IPs, una cuenta).
   * Cuenta TODOS los intentos, no solo los fallidos, para no necesitar una
   * lectura extra por petición. Trade-off aceptado: un atacante puede gastar
   * el cupo de una cuenta ajena y bloquearla 15 min (DoS de cuenta), pero el
   * límite por IP le obliga a repartirlo entre varias IPs.
   */
  loginPerEmail: { limit: envInt("RL_LOGIN_EMAIL_LIMIT", 30), windowSeconds: 15 * 60 },
  /**
   * "Olvidé mi contraseña" por IP. Más estricto que el login porque cada
   * petición aceptada cuesta un correo a un tercero: sin freno, este endpoint
   * es una máquina de spam gratis contra cualquier buzón (y quema la cuota de
   * Resend, igual que pasó con las 91 llamadas fallidas de §5.14).
   */
  forgotPerIp: { limit: envInt("RL_FORGOT_IP_LIMIT", 5), windowSeconds: 15 * 60 },
  /**
   * Por correo: evita el acoso a UNA cuenta desde muchas IPs. No abre un DoS
   * de cuenta como el de login —agotar el cupo no impide entrar, solo pedir
   * otro enlace— y el enlace ya enviado sigue siendo válido su hora.
   */
  forgotPerEmail: { limit: envInt("RL_FORGOT_EMAIL_LIMIT", 3), windowSeconds: 60 * 60 },
  /**
   * Canje del token. Adivinarlo es inviable (256 bits), así que esto no es el
   * freno principal: solo evita que alguien machaque el endpoint, que hace un
   * bcrypt.hash (lento a propósito) por petición válida.
   */
  passwordResetPerIp: { limit: envInt("RL_RESET_IP_LIMIT", 10), windowSeconds: 15 * 60 },
  /** Ingesta por dispositivo autenticado: el freno real ante una key filtrada. */
  ingestPerDevice: { limit: envInt("RL_INGEST_DEVICE_LIMIT", 1200), windowSeconds: 60 },
  /** Ingesta por IP, ANTES de autenticar: evita que keys inválidas golpeen la base sin freno. */
  ingestPerIp: { limit: envInt("RL_INGEST_IP_LIMIT", 2000), windowSeconds: 60 },
  /** Heartbeats: la RPi manda ~2/min; 120 es holgadísimo. */
  heartbeatPerDevice: { limit: envInt("RL_HEARTBEAT_DEVICE_LIMIT", 120), windowSeconds: 60 },
} as const;

/**
 * Borra contadores de ventanas ya vencidas. Se llama de forma probabilística
 * desde las rutas (dentro de `after()`, así no añade latencia) para no depender
 * de un cron que este proyecto no tiene.
 */
export async function purgeExpiredCounters(database: typeof db = db, olderThanSeconds = 3600): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
  try {
    await database.execute(sql`
      DELETE FROM rate_limit_counters WHERE window_start < ${cutoff.toISOString()}
    `);
  } catch (err) {
    console.error("[rate-limit] fallo al purgar contadores vencidos:", err);
  }
}

/** true una vez cada `1/probability` llamadas. Para disparar la purga sin cron. */
export function shouldPurge(probability = 0.01): boolean {
  return Math.random() < probability;
}

/** Respuesta 429 estándar con Retry-After. */
export function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}
