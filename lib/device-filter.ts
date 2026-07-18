/** Lee `?deviceId=` de una request de la API de lectura del dashboard. */
export function parseDeviceIdParam(request: Request): number | null {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("deviceId");
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
