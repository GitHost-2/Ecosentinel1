import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { devices, deviceOwners } from "@/db/schema";
import { getSessionUserId } from "@/lib/session";

/** Lee `?deviceId=` de una request de la API de lectura del dashboard. */
export function parseDeviceIdParam(request: Request): number | null {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("deviceId");
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Resuelve a qué dispositivos puede ver quien hace la petición.
 *
 * Multi-tenancy: antes las rutas de lectura no filtraban por dueño, así
 * que cualquiera (sin siquiera iniciar sesión) veía las detecciones de
 * TODOS los dispositivos de TODOS los clientes. Ahora se exige sesión y
 * se limita a los dispositivos de esa cuenta.
 *
 * Devuelve:
 *  - { error: 401 }        si no hay sesión válida
 *  - { deviceIds: [] }     si la cuenta no tiene dispositivos (respuesta vacía, no error)
 *  - { deviceIds: [...] }  los ids visibles, ya respetando ?deviceId= si vino
 */
export async function resolveVisibleDevices(request: Request): Promise<
  { ok: false; status: 401 | 403 } | { ok: true; deviceIds: number[] }
> {
  const userId = getSessionUserId(request);
  if (!userId) return { ok: false, status: 401 };

  // `deviceOwners` es muchos-a-muchos: no solo el dueño original
  // (`devices.ownerUserId`) ve un dispositivo, sino cualquier coautor -- ver
  // el comentario en db/schema.ts.
  const owned = await db
    .select({ id: devices.id })
    .from(devices)
    .innerJoin(deviceOwners, eq(deviceOwners.deviceId, devices.id))
    .where(eq(deviceOwners.userId, userId));
  const ownedIds = owned.map((d) => d.id);

  const requested = parseDeviceIdParam(request);
  if (requested !== null) {
    // Pedir un dispositivo ajeno no debe revelar si existe: se responde
    // como si la cuenta no tuviera nada que mostrar.
    if (!ownedIds.includes(requested)) return { ok: false, status: 403 };
    return { ok: true, deviceIds: [requested] };
  }
  return { ok: true, deviceIds: ownedIds };
}

export { inArray };
