/**
 * Da de alta un dispositivo (Raspberry Pi) real y genera su API key.
 * La API key en texto plano SOLO se muestra una vez en la terminal —
 * cópiala a la RPi (variable de entorno o archivo de config) en ese
 * momento, porque la base de datos solo guarda su hash (HMAC), no se
 * puede recuperar después.
 *
 * Uso:
 *   npm run db:create-device -- --cliente "Nombre del cliente" --plan Pro
 */
import "dotenv/config";
import { db } from "./index";
import { devices } from "./schema";
import { generateApiKey } from "../lib/device-auth";

function argValue(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const nombreCliente = argValue("--cliente", "Cliente sin nombre");
  const plan = argValue("--plan", "Pro");

  const { raw, hash } = generateApiKey();

  const [device] = await db
    .insert(devices)
    .values({ nombreCliente, apiKeyHash: hash, plan })
    .returning({ id: devices.id, nombreCliente: devices.nombreCliente });

  console.log("Dispositivo creado:");
  console.log(`  id: ${device.id}`);
  console.log(`  cliente: ${device.nombreCliente}`);
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
