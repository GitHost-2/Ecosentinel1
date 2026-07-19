/**
 * Da de alta un dispositivo (Raspberry Pi) real y genera su API key.
 * La API key en texto plano SOLO se muestra una vez en la terminal —
 * cópiala a la RPi (variable de entorno o archivo de config) en ese
 * momento, porque la base de datos solo guarda su hash (HMAC), no se
 * puede recuperar después.
 *
 * Uso:
 *   npm run db:create-device -- --cliente "Nombre del cliente" --plan Pro --owner-email dueno@empresa.com
 *
 * --owner-email es opcional: liga el dispositivo a una cuenta de
 * `users` ya registrada, para que las alertas por ataque (ver
 * lib/alerts.ts) sepan a quién mandarle el correo. Sin este flag el
 * dispositivo queda sin dueño y no se manda ninguna alerta hasta que
 * se asigne uno (UPDATE devices SET owner_user_id = ... WHERE id = ...).
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
