/**
 * Da de alta un dispositivo (RPi) y genera su API key (solo se muestra una vez, la BD guarda el hash).
 * Uso: npm run db:create-device -- --cliente "Nombre" --plan Pro --owner-email dueno@empresa.com
 * --owner-email es opcional; sin él el dispositivo queda sin dueño y sin alertas por correo.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { devices, users } from "./schema";
import { generateApiKey } from "../lib/device-auth";

function argValue(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const nombreCliente = argValue("--cliente", "Cliente sin nombre");
  const plan = argValue("--plan", "Pro");
  const ownerEmail = argValue("--owner-email", "");

  let ownerUserId: number | null = null;
  if (ownerEmail) {
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail)).limit(1);
    if (!owner) {
      console.error(`No existe ningún usuario registrado con el correo "${ownerEmail}". Créalo primero desde el registro del landing.`);
      process.exit(1);
    }
    ownerUserId = owner.id;
  }

  const { raw, hash } = generateApiKey();

  const [device] = await db
    .insert(devices)
    .values({ nombreCliente, apiKeyHash: hash, plan, ownerUserId })
    .returning({ id: devices.id, nombreCliente: devices.nombreCliente });

  console.log("Dispositivo creado:");
  console.log(`  id: ${device.id}`);
  console.log(`  cliente: ${device.nombreCliente}`);
  console.log(`  dueño: ${ownerEmail || "(sin asignar — no recibirá alertas por correo)"}`);
  console.log("");
  console.log("API key (cópiala AHORA, no se vuelve a mostrar):");
  console.log(`  ${raw}`);
  console.log("");
  console.log("En la Raspberry Pi, usa esta key en cada request:");
  console.log(`  Authorization: Bearer ${raw}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
