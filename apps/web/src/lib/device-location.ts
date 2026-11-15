import { prisma } from "@orison/db";

import {
  createIchnaeaProvider,
  createOpenCellIdProvider,
  resolveCellLocation,
  type CachedCell,
  type CellCacheStore,
  type CellKey,
  type CellLocationProvider,
} from "./cell-lookup";
import { env } from "./env";
import { parseHeartbeatLocation, type ServingCell } from "./qeng";

export type ResolvedLocation = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  source: "gps" | "cell";
  at: Date;
  provider?: string;
};

export const prismaCellCacheStore: CellCacheStore = {
  async get(cell: CellKey): Promise<CachedCell | null> {
    const row = await prisma.cellTowerLocation.findUnique({
      where: {
        radio_mcc_mnc_lac_cellId: {
          radio: cell.radio,
          mcc: cell.mcc,
          mnc: cell.mnc,
          lac: cell.lac,
          cellId: cell.cellId,
        },
      },
    });
    return row
      ? {
          found: row.found,
          lat: row.lat,
          lng: row.lng,
          accuracyM: row.accuracyM,
          provider: row.provider,
          retryAfter: row.retryAfter,
          lookedUpAt: row.lookedUpAt,
        }
      : null;
  },
  async put(cell: CellKey, entry: CachedCell) {
    const key = { radio: cell.radio, mcc: cell.mcc, mnc: cell.mnc, lac: cell.lac, cellId: cell.cellId };
    await prisma.cellTowerLocation.upsert({
      where: { radio_mcc_mnc_lac_cellId: key },
      update: entry,
      create: { ...key, ...entry },
    });
  },
};

export function configuredCellProviders(): CellLocationProvider[] {
  const providers: CellLocationProvider[] = [];
  if (env.openCellIdApiKey) {
    providers.push(createOpenCellIdProvider({ apiKey: env.openCellIdApiKey, userAgent: env.cellLookupUserAgent }));
  }
  if (!env.cellLookupDisablePublic) {
    providers.push(
      createIchnaeaProvider({ name: "beacondb", url: env.cellLookupBeaconDbUrl, userAgent: env.cellLookupUserAgent }),
    );
  }
  return providers;
}

/**
 * Best position for one heartbeat: GPS fix wins, otherwise the serving cell resolved through the
 * cache/providers. Returns the parsed serving cell too so it can be recorded. Never throws.
 */
export async function resolveHeartbeatLocation(
  location: unknown,
  now: Date = new Date(),
): Promise<{ position: ResolvedLocation | null; cell: ServingCell | null }> {
  let parsed: ReturnType<typeof parseHeartbeatLocation>;
  try {
    parsed = parseHeartbeatLocation(location);
  } catch (error) {
    console.warn("heartbeat location parse failed", error);
    return { position: null, cell: null };
  }

  if (parsed.gps) {
    const fixTime = parsed.gps.fixTime && parsed.gps.fixTime <= now ? parsed.gps.fixTime : now;
    return {
      position: { lat: parsed.gps.lat, lng: parsed.gps.lng, accuracyM: parsed.gps.accuracyM, source: "gps", at: fixTime },
      cell: parsed.cell,
    };
  }

  if (!parsed.cell) {
    return { position: null, cell: null };
  }

  try {
    const resolved = await resolveCellLocation(parsed.cell, {
      store: prismaCellCacheStore,
      providers: configuredCellProviders(),
      timeoutMs: env.cellLookupTimeoutMs,
      now,
    });
    return {
      position: resolved
        ? { lat: resolved.lat, lng: resolved.lng, accuracyM: resolved.accuracyM, source: "cell", at: now, provider: resolved.provider }
        : null,
      cell: parsed.cell,
    };
  } catch (error) {
    console.warn("cell location resolution failed", error);
    return { position: null, cell: parsed.cell };
  }
}
