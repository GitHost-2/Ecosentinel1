import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

// Umbral para considerar un dispositivo "en línea": si su último
// heartbeat es más viejo que esto, se marca offline. La RPi todavía no
// tiene un intervalo de heartbeat fijo documentado (ver setup_rpi.sh);
// 3 minutos da margen para un par de heartbeats perdidos sin marcar
// offline de más. Ajustar si el intervalo real termina siendo otro.
const ONLINE_THRESHOLD_MS = 3 * 60 * 1000;

type DeviceRow = {
  id: number;
  nombre_cliente: string;
  plan: string;
  last_heartbeat: string | null;
  cpu_pct: number | null;
  ram_pct: number | null;
};

export async function GET() {
  const result = await db.execute<DeviceRow>(sql`
    select
      d.id,
      d.nombre_cliente,
      d.plan,
      lh.last_heartbeat,
      lh.cpu_pct,
      lh.ram_pct
    from devices d
    left join lateral (
      select h.timestamp as last_heartbeat, h.cpu_pct, h.ram_pct
      from device_heartbeats h
      where h.device_id = d.id
      order by h.timestamp desc
      limit 1
    ) lh on true
    order by d.id
  `);

  // neon-http devuelve { rows, fields, ... } para SQL crudo, no un array
  // directo (ver el mismo fix en app/api/hourly/route.ts).
  const now = Date.now();
  const devices = result.rows.map((row) => {
    const lastHeartbeat = row.last_heartbeat ? new Date(row.last_heartbeat) : null;
    const online = !!lastHeartbeat && now - lastHeartbeat.getTime() <= ONLINE_THRESHOLD_MS;
    return {
      id: row.id,
      nombreCliente: row.nombre_cliente,
      plan: row.plan,
      lastHeartbeat: lastHeartbeat ? lastHeartbeat.toISOString() : null,
      cpuPct: row.cpu_pct,
      ramPct: row.ram_pct,
      online,
    };
  });

  return NextResponse.json(devices);
}
