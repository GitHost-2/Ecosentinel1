import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { detections, mitigations } from "@/db/schema";

export const dynamic = "force-dynamic";

// Misma "alta confianza" que /api/stats -- solo se sugiere aislar lo que
// ya cuenta como bloqueado. Nunca se acepta sobre detecciones de baja
// confianza: es justo el escenario que más falsos positivos daría.
const BLOCK_THRESHOLD = 0.7;

/**
 * Confirma "Aislar IP" sobre una detección de alta confianza.
 *
 * IMPORTANTE: esto NUNCA toca la red. La Raspberry Pi es un cliente WiFi
 * (sin Ethernet, no está "en línea" en la red), así que no tiene forma
 * de bloquear tráfico de otro dispositivo por sí sola. Esta ruta solo
 * registra la confirmación humana y devuelve la guía para que la
 * persona bloquee la IP donde sí se puede: el router.
 *
 * La IP real nunca llegó a esta base de datos (solo su hash, ver
 * lib/device-auth.ts) -- la guía apunta al log local de la RPi, que es
 * el único lugar donde esa IP existe en texto plano.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const detectionId = Number(body?.detectionId);
  if (!Number.isInteger(detectionId) || detectionId <= 0) {
    return NextResponse.json({ error: "detectionId inválido." }, { status: 400 });
  }

  const [detection] = await db.select().from(detections).where(eq(detections.id, detectionId)).limit(1);
  if (!detection) {
    return NextResponse.json({ error: "Detección no encontrada." }, { status: 404 });
  }
  if (detection.attackProb < BLOCK_THRESHOLD) {
    return NextResponse.json(
      { error: "Esta detección no alcanza la confianza mínima (70%) para sugerir aislamiento." },
      { status: 400 },
    );
  }

  await db.insert(mitigations).values({ detectionId: detection.id, deviceId: detection.deviceId }).onConflictDoNothing();

  // Ventana de +-10s alrededor de la detección para ubicar la línea
  // exacta en el log local (el timestamp del log es el mismo reloj que
  // el de esta fila, ambos vienen de la RPi).
  const since = new Date(detection.timestamp.getTime() - 10_000).toISOString();
  const until = new Date(detection.timestamp.getTime() + 10_000).toISOString();

  return NextResponse.json({
    ok: true,
    guidance: {
      findRealIpCommand: `journalctl -u ecosentinel --since "${since}" --until "${until}" | grep ATAQUE`,
      steps: [
        "La IP real nunca sale de tu Raspberry Pi -- solo se guarda un hash en esta base de datos. Corre el comando de arriba por SSH en tu RPi para verla en el log local, cerca de la hora de esta alerta.",
        "En el panel de administración de tu router (normalmente 192.168.1.1 o 192.168.0.1), busca \"Control de acceso\", \"Firewall\" o \"Filtrado de IP/MAC\" y agrega esa IP a la lista de bloqueados.",
        "Si es un dispositivo desconocido conectado por WiFi, revisa la lista de dispositivos conectados de tu router, desconéctalo, y considera cambiar la contraseña del WiFi.",
      ],
    },
  });
}
