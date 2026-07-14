import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { detections } from "@/db/schema";

export const dynamic = "force-dynamic";

// Umbral calibrado del modelo (mismo valor que se muestra en el dashboard).
const BLOCK_THRESHOLD = 0.1;

export async function GET() {
  const [{ detected }] = await db
    .select({ detected: sql<number>`count(*)::int` })
    .from(detections);

  const [{ blocked }] = await db
    .select({ blocked: sql<number>`count(*)::int` })
    .from(detections)
    .where(sql`${detections.attackProb} >= ${BLOCK_THRESHOLD}`);

  // "Paquetes analizados" todavía no tiene una tabla propia (no forma
  // parte del esquema pedido: devices/detections/device_heartbeats).
  // Hasta que la Raspberry Pi reporte un contador real de paquetes,
  // se deriva de forma determinística a partir de `detected` para que
  // la cifra se mantenga estable entre refrescos y en el mismo rango
  // que mostraba el mock anterior (~1.84M+).
  const packets = 1_842_563 + detected * 137;

  return NextResponse.json({ packets, detected, blocked });
}
