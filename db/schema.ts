import { pgTable, serial, text, timestamp, integer, real } from "drizzle-orm/pg-core";

// Cuentas creadas desde el formulario de registro del landing (empresa,
// correo, plan, contraseña) + el perfil de conocimiento del cuestionario
// (principiante/intermedio/avanzado). Separada de `devices`: esta tabla es
// la identidad de la persona que entra al dashboard; `devices` es la
// identidad del appliance físico (RPi) que va a mandar detecciones.
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
});

// Nota: `attackType` (Ransomware, DDoS, Port Scanning, Botnet Mirai,
// Brute Force, Spoofing) se agregó junto a `protocol` porque la UI del
// dashboard necesita la familia de ataque clasificada por el modelo,
// mientras que `protocol` describe la capa de red (TCP/UDP/ICMP).
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
});

export const deviceHeartbeats = pgTable("device_heartbeats", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  cpuPct: real("cpu_pct").notNull(),
  ramPct: real("ram_pct").notNull(),
  modeloVersion: text("modelo_version").notNull(),
});
