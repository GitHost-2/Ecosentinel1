import { pgTable, serial, text, timestamp, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";

// Cuentas del landing (empresa, correo, plan, perfil de conocimiento).
// Separada de `devices`: aquí vive la persona, allá el appliance físico.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  company: text("company").notNull(),
  email: text("email").notNull().unique(),
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

// Registro de cada correo de alerta enviado (ver lib/alerts.ts: cooldown + auditoría).
export const alertLog = pgTable("alert_log", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  detectionId: integer("detection_id").references(() => detections.id, { onDelete: "set null" }),
  recipientEmail: text("recipient_email").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("alert_log_device_id_sent_at_idx").on(table.deviceId, table.sentAt),
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
