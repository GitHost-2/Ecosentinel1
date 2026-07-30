import { pgTable, serial, text, timestamp, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

// Cuentas del landing (empresa, correo, plan, perfil de conocimiento).
// Separada de `devices`: aquí vive la persona, allá el appliance físico.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  company: text("company").notNull(),
  email: text("email").notNull().unique(),
  // Número de WhatsApp en formato E.164 (ej. +5215512345678). Nullable: sin él no se manda alerta por WhatsApp.
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  plan: text("plan").notNull().default("Pro"),
  profile: text("profile").notNull().default("intermedio"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  nombreCliente: text("nombre_cliente").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  fechaAlta: timestamp("fecha_alta", { withTimezone: true }).notNull().defaultNow(),
  plan: text("plan").notNull().default("Pro"),
  // Dueño de este dispositivo, a quién avisar por correo. Nullable hasta que se asigne.
  ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),
}, (table) => [
  // authenticateDevice() busca por este hash en cada request de ingesta.
  uniqueIndex("devices_api_key_hash_idx").on(table.apiKeyHash),
]);

// `attackType`: familia de ataque (Ransomware/DDoS/etc). `protocol`: capa de red (TCP/UDP/ICMP).
export const detections = pgTable("detections", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  attackProb: real("attack_prob").notNull(),
  protocol: text("protocol").notNull(),
  attackType: text("attack_type").notNull(),
  srcIpHash: text("src_ip_hash").notNull(),
  dstPort: integer("dst_port").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Índices para las queries por rango de timestamp de /api/alerts, /api/hourly y /api/threats.
  index("detections_timestamp_idx").on(table.timestamp),
  index("detections_device_id_timestamp_idx").on(table.deviceId, table.timestamp),
]);

// Registro de cada alerta enviada por email o whatsapp (ver lib/alerts.ts: cooldown + auditoría).
// El cooldown de 10 min es por dispositivo Y por canal (email y whatsapp corren independientes).
export const alertLog = pgTable("alert_log", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  detectionId: integer("detection_id").references(() => detections.id, { onDelete: "set null" }),
  channel: text("channel").notNull().default("email"), // 'email' | 'whatsapp'
  recipient: text("recipient").notNull(), // email o número de whatsapp
  // 'sent' = entregado al proveedor | 'failed' = el proveedor lo rechazó.
  // Antes solo se guardaba fila cuando el envío tenía ÉXITO, así que un canal
  // averiado no dejaba rastro y el cooldown no lo frenaba: se reintentaba en
  // CADA detección (se observó el 2026-07-30: 91 llamadas fallidas a Resend en
  // segundos). Ahora se registra también el fallo, con su propia ventana.
  // Default 'sent' para que las filas anteriores a esta columna sigan valiendo.
  status: text("status").notNull().default("sent"), // 'sent' | 'failed'
  // Momento del INTENTO (haya salido bien o mal), no solo del envío logrado.
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("alert_log_device_id_channel_sent_at_idx").on(table.deviceId, table.channel, table.sentAt),
]);

// Marca que un humano confirmó "Aislar IP" sobre una detección de alta
// confianza (ver app/api/mitigate/route.ts). La RPi NUNCA bloquea nada
// sola: esto solo registra la confirmación y sirve para no repetir la
// guía dos veces sobre la misma detección.
export const mitigations = pgTable("mitigations", {
  id: serial("id").primaryKey(),
  detectionId: integer("detection_id")
    .notNull()
    .references(() => detections.id, { onDelete: "cascade" }),
  deviceId: integer("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("mitigations_detection_id_idx").on(table.detectionId),
]);

// Contadores de rate limiting (ver lib/rate-limit.ts). Una fila por
// (identificador, ventana): el login se limita por IP y por correo, la ingesta
// por dispositivo. Vive en la base porque en Vercel cada invocación puede
// correr en otro proceso, así que un contador en memoria no limitaría nada.
// Las filas de ventanas vencidas ya no se leen; se purgan desde la propia
// ruta de forma probabilística para no depender de un cron.
export const rateLimitCounters = pgTable("rate_limit_counters", {
  bucketKey: text("bucket_key").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.bucketKey, table.windowStart] }),
  // Para el DELETE de purga por ventana vencida.
  index("rate_limit_counters_window_start_idx").on(table.windowStart),
]);

export const deviceHeartbeats = pgTable("device_heartbeats", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  cpuPct: real("cpu_pct").notNull(),
  ramPct: real("ram_pct").notNull(),
  modeloVersion: text("modelo_version").notNull(),
  // Delta de paquetes desde el heartbeat anterior (no acumulado, para que un reinicio no rompa el total).
  packetsProcessed: integer("packets_processed").notNull().default(0),
}, (table) => [
  index("device_heartbeats_device_id_timestamp_idx").on(table.deviceId, table.timestamp),
]);
