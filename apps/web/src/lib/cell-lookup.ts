// Cell tower -> coordinates resolution with a cache (positive and negative) and pluggable
// providers. No Prisma here: the store and fetch are injected so this can be unit-tested.
// Only the tower identifiers (radio, mcc, mnc, lac/tac, cell id) are ever sent to a provider.

import type { CellRadio, ServingCell } from "./qeng";

export type CellKey = Pick<ServingCell, "radio" | "mcc" | "mnc" | "lac" | "cellId">;

export type ProviderResult =
  | { status: "found"; lat: number; lng: number; accuracyM: number | null }
  | { status: "not_found" }
  | { status: "error"; message: string };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CellLocationProvider {
  name: string;
  lookup(cell: CellKey, context: { fetch: FetchLike; signal: AbortSignal }): Promise<ProviderResult>;
}

export type CachedCell = {
  found: boolean;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  provider: string | null;
  retryAfter: Date | null;
  lookedUpAt: Date;
};

export interface CellCacheStore {
  get(cell: CellKey): Promise<CachedCell | null>;
  put(cell: CellKey, entry: CachedCell): Promise<void>;
}

export type CellLocation = { lat: number; lng: number; accuracyM: number | null; provider: string };

export const NOT_FOUND_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
export const ERROR_RETRY_MS = 60 * 60 * 1000;
export const POSITIVE_REFRESH_MS = 90 * 24 * 60 * 60 * 1000;

function validCoordinates(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

const openCellIdRadio: Record<CellRadio, string> = { lte: "LTE", wcdma: "UMTS", gsm: "GSM" };

/** OpenCelliD `cell/get` (API key required). */
export function createOpenCellIdProvider(options: {
  apiKey: string;
  baseUrl?: string;
  userAgent?: string;
}): CellLocationProvider {
  const baseUrl = options.baseUrl ?? "https://opencellid.org/cell/get";
  return {
    name: "opencellid",
    async lookup(cell, { fetch, signal }) {
      const url = new URL(baseUrl);
      url.searchParams.set("key", options.apiKey);
      url.searchParams.set("mcc", String(cell.mcc));
      url.searchParams.set("mnc", String(cell.mnc));
      url.searchParams.set("lac", String(cell.lac));
      url.searchParams.set("cellid", String(cell.cellId));
      url.searchParams.set("radio", openCellIdRadio[cell.radio]);
      url.searchParams.set("format", "json");

      const response = await fetch(url.toString(), {
        signal,
        headers: { Accept: "application/json", ...(options.userAgent ? { "User-Agent": options.userAgent } : {}) },
      });
      return parseOpenCellIdResponse(response.status, await response.text());
    },
  };
}

export function parseOpenCellIdResponse(httpStatus: number, body: string): ProviderResult {
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = null;
  }

  if (json && validCoordinates(json.lat, json.lon)) {
    const range = typeof json.range === "number" && json.range > 0 ? json.range : null;
    return { status: "found", lat: json.lat as number, lng: json.lon as number, accuracyM: range };
  }

  const errorText = json ? String(json.error ?? json.message ?? json.status ?? "") : body.slice(0, 200);
  // OpenCelliD answers `{"error":"Cell not found","code":1}` for unknown towers.
  if (httpStatus === 404 || (json && json.code === 1) || /not\s*found/i.test(errorText)) {
    return { status: "not_found" };
  }
  return { status: "error", message: `opencellid HTTP ${httpStatus}: ${errorText || "unexpected response"}` };
}

/** Ichnaea-compatible geolocate API (beaconDB, keyless). */
export function createIchnaeaProvider(options: {
  name?: string;
  url?: string;
  userAgent?: string;
}): CellLocationProvider {
  const url = options.url ?? "https://api.beacondb.net/v1/geolocate";
  return {
    name: options.name ?? "beacondb",
    async lookup(cell, { fetch, signal }) {
      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
        },
        body: JSON.stringify(buildIchnaeaRequest(cell)),
      });
      return parseIchnaeaResponse(response.status, await response.text());
    },
  };
}

export function buildIchnaeaRequest(cell: CellKey) {
  return {
    // Never let the service fall back to the caller's (server's) IP address.
    considerIp: false,
    fallbacks: { ipf: false, lacf: true },
    cellTowers: [
      {
        radioType: cell.radio,
        mobileCountryCode: cell.mcc,
        mobileNetworkCode: cell.mnc,
        locationAreaCode: cell.lac,
        cellId: cell.cellId,
      },
    ],
  };
}

export function parseIchnaeaResponse(httpStatus: number, body: string): ProviderResult {
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = null;
  }

  if (httpStatus === 200 && json && json.location && typeof json.location === "object") {
    const location = json.location as Record<string, unknown>;
    if (validCoordinates(location.lat, location.lng)) {
      const accuracy = typeof json.accuracy === "number" && json.accuracy > 0 ? json.accuracy : null;
      return { status: "found", lat: location.lat as number, lng: location.lng as number, accuracyM: accuracy };
    }
  }

  if (httpStatus === 404) {
    return { status: "not_found" };
  }
  return { status: "error", message: `geolocate HTTP ${httpStatus}` };
}

function cellLabel(cell: CellKey) {
  return `${cell.radio}/${cell.mcc}/${cell.mnc}/${cell.lac}/${cell.cellId}`;
}

/**
 * Resolve a cell's coordinates. Never throws: on any failure it returns null (and caches the
 * failure so the providers are not hammered every heartbeat).
 */
export async function resolveCellLocation(
  cell: CellKey,
  options: {
    store: CellCacheStore;
    providers: CellLocationProvider[];
    fetch?: FetchLike;
    timeoutMs?: number;
    now?: Date;
    logger?: Pick<Console, "warn">;
  },
): Promise<CellLocation | null> {
  const now = options.now ?? new Date();
  const logger = options.logger ?? console;
  let cached: CachedCell | null = null;

  try {
    cached = await options.store.get(cell);
  } catch (error) {
    logger.warn(`cell cache read failed for ${cellLabel(cell)}`, error);
  }

  const cachedLocation =
    cached?.found && cached.lat !== null && cached.lng !== null
      ? { lat: cached.lat, lng: cached.lng, accuracyM: cached.accuracyM, provider: cached.provider ?? "cache" }
      : null;

  if (
    cachedLocation &&
    (now.getTime() - cached!.lookedUpAt.getTime() < POSITIVE_REFRESH_MS ||
      (cached!.retryAfter !== null && cached!.retryAfter > now))
  ) {
    return cachedLocation;
  }
  if (cached && !cached.found && cached.retryAfter && cached.retryAfter > now) {
    return null;
  }
  if (options.providers.length === 0) {
    return cachedLocation;
  }

  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 3000;
  let sawError = false;

  for (const provider of options.providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: ProviderResult;
    try {
      result = await provider.lookup(cell, { fetch: fetchImpl, signal: controller.signal });
    } catch (error) {
      result = {
        status: "error",
        message: controller.signal.aborted ? "timeout" : error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }

    if (result.status === "found") {
      const entry: CachedCell = {
        found: true,
        lat: result.lat,
        lng: result.lng,
        accuracyM: result.accuracyM,
        provider: provider.name,
        retryAfter: null,
        lookedUpAt: now,
      };
      await options.store.put(cell, entry).catch((error) => logger.warn("cell cache write failed", error));
      return { lat: result.lat, lng: result.lng, accuracyM: result.accuracyM, provider: provider.name };
    }

    if (result.status === "error") {
      sawError = true;
      logger.warn(`cell lookup via ${provider.name} failed for ${cellLabel(cell)}: ${result.message}`);
    }
  }

  if (cachedLocation) {
    // Refresh failed: keep serving the old position and try again later.
    await options.store
      .put(cell, { ...cached!, retryAfter: new Date(now.getTime() + ERROR_RETRY_MS) })
      .catch(() => undefined);
    return cachedLocation;
  }

  await options.store
    .put(cell, {
      found: false,
      lat: null,
      lng: null,
      accuracyM: null,
      provider: null,
      retryAfter: new Date(now.getTime() + (sawError ? ERROR_RETRY_MS : NOT_FOUND_RETRY_MS)),
      lookedUpAt: now,
    })
    .catch((error) => logger.warn("cell cache write failed", error));
  return null;
}
