/**
 * Seed de datos de ejemplo para desarrollo/demo (dispositivo + detecciones
 * de los últimos 14 días). `src_ip_hash` aquí es un string con forma de IP
 * solo para fines visuales, no un hash real.
 * Uso: npm run db:seed (requiere DATABASE_URL)
 */
import "dotenv/config";
import { db } from "./index";
import { devices, detections, deviceHeartbeats, users, deviceOwners } from "./schema";

const ATTACK_PROFILES = [
  { type: "Ransomware", weight: 22, protocol: "TCP", ports: [445, 3389] },
  { type: "Brute Force", weight: 20, protocol: "TCP", ports: [22, 3389, 21] },
  { type: "Port Scanning", weight: 18, protocol: "TCP", ports: [21, 23, 80, 443, 3306, 8080] },
  { type: "DDoS", weight: 16, protocol: "UDP", ports: [80, 443, 53] },
  { type: "Botnet Mirai", weight: 14, protocol: "TCP", ports: [23, 2323] },
  { type: "Spoofing", weight: 10, protocol: "ICMP", ports: [0] },
] as const;

const IP_POOLS = ["192.168", "10.0", "172.16", "45.83", "185.220", "103.94"];

function weightedRandomProfile() {
  const total = ATTACK_PROFILES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of ATTACK_PROFILES) {
    if (r < p.weight) return p;
    r -= p.weight;
  }
  return ATTACK_PROFILES[0];
}

function randPseudoIp() {
  const base = IP_POOLS[Math.floor(Math.random() * IP_POOLS.length)];
  return `${base}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log("Insertando dispositivo demo...");
  // api_key_hash es un placeholder, no sirve para /api/ingest/*. Para una RPi real usa db:create-device.
  const [device] = await db
    .insert(devices)
    .values({
      nombreCliente: "Demo Empresa",
      apiKeyHash: "demo_placeholder_hash_do_not_use_in_prod",
      plan: "Pro",
    })
    .returning();

  // Coautoría (ver db/schema.ts, deviceOwners): todo usuario ya registrado
  // en esta base queda con acceso al dispositivo de demo recién creado.
  const todosLosUsuarios = await db.select({ id: users.id }).from(users);
  if (todosLosUsuarios.length > 0) {
    await db
      .insert(deviceOwners)
      .values(todosLosUsuarios.map((u) => ({ deviceId: device.id, userId: u.id })))
      .onConflictDoNothing();
  }

  console.log(`Dispositivo creado con id=${device.id}. Generando detecciones...`);

  const HISTORY_DAYS = 14;
  const now = Date.now();
  const rows: (typeof detections.$inferInsert)[] = [];

  for (let day = 0; day < HISTORY_DAYS; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const count = 4 + Math.round(Math.abs(Math.sin(hour / 3)) * 10 + Math.random() * 6);
      for (let i = 0; i < count; i++) {
        const profile = weightedRandomProfile();
        const minutesAgo = day * 24 * 60 + (23 - hour) * 60 + randInt(0, 59);
        const timestamp = new Date(now - minutesAgo * 60_000);
        const attackProb = 0.72 + Math.random() * 0.279;
        const port = profile.ports[Math.floor(Math.random() * profile.ports.length)];

        rows.push({
          deviceId: device.id,
          timestamp,
          attackProb,
          protocol: profile.protocol,
          attackType: profile.type,
          srcIpHash: randPseudoIp(),
          dstPort: port,
        });
      }
    }
  }

  console.log(`Insertando ${rows.length} detecciones en lotes...`);
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(detections).values(rows.slice(i, i + BATCH));
    console.log(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  console.log("Insertando heartbeats de las últimas 24h...");
  const heartbeatRows: (typeof deviceHeartbeats.$inferInsert)[] = [];
  for (let i = 0; i < 48; i++) {
    heartbeatRows.push({
      deviceId: device.id,
      timestamp: new Date(now - i * 30 * 60_000),
      cpuPct: 15 + Math.random() * 50,
      ramPct: 20 + Math.random() * 50,
      modeloVersion: "rf-v1.3",
    });
  }
  await db.insert(deviceHeartbeats).values(heartbeatRows);

  console.log("Listo.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
