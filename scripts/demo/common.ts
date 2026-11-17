// Shared helpers for the local demo fleet scripts. Demo-only: never imported by app code.
import { existsSync } from "node:fs";
import path from "node:path";

// Run through tsx as CommonJS (root package.json has no "type": "module").
export const repoRoot = path.resolve(__dirname, "../..");
export const webRoot = path.join(repoRoot, "apps/web");

/** Load the repo .env (without overriding already-set variables). */
export function loadEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

export const DEMO_SERIAL_PREFIX = "DEMO-CAB-";
export const DEMO_GROUPS = [
  { name: "Demo · West End", description: "Demo fleet: cabs working the West End" },
  { name: "Demo · City", description: "Demo fleet: cabs working the City and Shoreditch" },
] as const;

/** The ten-slot rotation (built in the loop builder's format and compiled by the real publisher). */
export const DEMO_ROTATION = {
  name: "Demo · Ten-slot rotation",
  adverts: [
    { key: "ad-coffee", label: "Coffee 10s", seconds: 10, color: "0x6f4e37" },
    { key: "ad-theatre", label: "Theatre 15s", seconds: 15, color: "0x6a040f" },
    { key: "ad-bank", label: "Bank 20s", seconds: 20, color: "0x003049" },
    { key: "ad-airline", label: "Airline 30s", seconds: 30, color: "0x0077b6" },
  ],
  fillers: [
    { key: "fill-london", label: "London 20s", seconds: 20, color: "0x2d6a4f" },
    { key: "fill-tips", label: "Tips 30s", seconds: 30, color: "0x7f5539" },
    { key: "fill-brand", label: "Orison 45s", seconds: 45, color: "0x0c1322" },
  ],
  // Per slot: advert, then fillers; each slot is exactly one minute.
  slots: [
    ["ad-coffee", "fill-london", "fill-tips"],
    ["ad-theatre", "fill-brand"],
    ["ad-bank", "fill-london", "fill-london"],
    ["ad-airline", "fill-tips"],
    ["ad-coffee", "fill-tips", "fill-london"],
    ["ad-theatre", "fill-brand"],
    ["ad-bank", "fill-london", "fill-london"],
    ["ad-airline", "fill-tips"],
    ["ad-coffee", "fill-london", "fill-tips"],
    ["ad-theatre", "fill-brand"],
  ],
} as const;

export const DEMO_LOOPS = [
  { key: "spring", name: "Demo · Spring campaign", color: "0x1d3557", size: "1280x800", ext: "mp4", label: "Spring campaign" },
  { key: "theatre", name: "Demo · Theatre week", color: "0x6a040f", size: "1920x1080", ext: "mov", label: "Theatre week" },
  { key: "portrait", name: "Demo · Portrait phone clip", color: "0x2d6a4f", size: "1080x1920", ext: "mov", label: "Portrait clip" },
] as const;

// Fake-but-valid UK tower used by the "cell only" cab. Its coordinates are seeded into the
// CellTowerLocation cache, so the server resolves it without calling any provider.
export const DEMO_CELL = { radio: "lte", mcc: 234, mnc: 10, tac: 0x2b67, cellId: 0x1a2d3e4, lat: 51.5154, lng: -0.1419, accuracyM: 900 };
export const DEMO_CELL_RAW = `+QENG: "servingcell","NOCONN","LTE","FDD",234,10,${DEMO_CELL.cellId
  .toString(16)
  .toUpperCase()},215,1617,3,5,5,${DEMO_CELL.tac.toString(16).toUpperCase()},-97,-11,-66,9,38`;

export type DemoSync = { state: "ok" | "downloading" | "failed"; error: string | null; sinceMinutesAgo: number; nextRetryMinutes: number | null };

export type DemoCab = {
  serial: string;
  plate: string;
  driver: string | null;
  group: 0 | 1 | null;
  scenario: "gps" | "cell" | "override" | "updating" | "offline" | "paused" | "never" | "gappy";
  center: [number, number];
  alive: boolean; // demo:heartbeat keeps these online
  playerStatus: "playing" | "silent" | "idle" | "disabled";
  /** Firmware 1.2.0 reports these; 1.0.0 (the cell-only cab, like the real pilot cab) does not. */
  firmware: "1.0.0" | "1.2.0";
  playerState: "IDLE" | "SAFETY" | "JOURNEY" | "SILENT" | "WIND_DOWN" | "DISABLED" | null;
  /** gpio: door/button inputs (passenger journeys). always: no passenger detection (x86 box). */
  trigger: "gpio" | "always" | null;
  sync: DemoSync | null;
  /** 1.2.0 sends signalStrength only as dBm; boxes on the NetworkManager fallback know a percentage. */
  signal: { dbm: number | null; percent: number | null };
};

const OK: DemoSync = { state: "ok", error: null, sinceMinutesAgo: 180, nextRetryMinutes: null };

export const DEMO_CABS: DemoCab[] = [
  { serial: "DEMO-CAB-01", plate: "LX21 KCB", driver: "Sam Okafor", group: 0, scenario: "gps", center: [51.5101, -0.1340], alive: true, playerStatus: "playing", firmware: "1.2.0", playerState: "JOURNEY", trigger: "gpio", sync: OK, signal: { dbm: -88, percent: 71 } },
  { serial: "DEMO-CAB-02", plate: "LT19 HPR", driver: "Priya Shah", group: 0, scenario: "cell", center: [51.5154, -0.1419], alive: true, playerStatus: "idle", firmware: "1.0.0", playerState: null, trigger: null, sync: null, signal: { dbm: -97, percent: null } },
  { serial: "DEMO-CAB-03", plate: "LB70 TXI", driver: "Tom Reilly", group: 0, scenario: "override", center: [51.5033, -0.1196], alive: true, playerStatus: "playing", firmware: "1.2.0", playerState: "SAFETY", trigger: "gpio", sync: OK, signal: { dbm: -79, percent: 84 } },
  {
    serial: "DEMO-CAB-04", plate: "LR68 FBN", driver: "Grace Mensah", group: 1, scenario: "updating", center: [51.5155, -0.0922], alive: true, playerStatus: "silent",
    firmware: "1.2.0", playerState: "SILENT", trigger: "gpio",
    sync: { state: "failed", error: "download of loop.mp4 failed: connection closed after 18874368 of 61203456 bytes", sinceMinutesAgo: 95, nextRetryMinutes: 22 },
    signal: { dbm: -109, percent: 18 },
  },
  { serial: "DEMO-CAB-05", plate: "LK18 WQS", driver: "Dan Cohen", group: 1, scenario: "offline", center: [51.5246, -0.0786], alive: false, playerStatus: "idle", firmware: "1.2.0", playerState: "IDLE", trigger: "gpio", sync: OK, signal: { dbm: -91, percent: 64 } },
  { serial: "DEMO-CAB-06", plate: "LN67 ZTA", driver: "Aisha Rahman", group: null, scenario: "paused", center: [51.4975, -0.1357], alive: true, playerStatus: "disabled", firmware: "1.2.0", playerState: "DISABLED", trigger: "gpio", sync: OK, signal: { dbm: -85, percent: 75 } },
  { serial: "DEMO-CAB-07", plate: "LC22 NEW", driver: null, group: 1, scenario: "never", center: [51.5072, -0.1276], alive: false, playerStatus: "idle", firmware: "1.2.0", playerState: null, trigger: null, sync: null, signal: { dbm: null, percent: null } },
  // Like the real pilot cab: an x86 box with no GPIO (always mode) on the NetworkManager fallback.
  { serial: "DEMO-CAB-08", plate: "LV20 MRK", driver: "Joe Barnes", group: 0, scenario: "gappy", center: [51.5079, -0.0877], alive: true, playerStatus: "playing", firmware: "1.2.0", playerState: "JOURNEY", trigger: "always", sync: OK, signal: { dbm: null, percent: 62 } },
];

/** Deterministic small wander around a centre (about +-600m). */
export function wander(center: [number, number], step: number, seed: number): { lat: number; lng: number } {
  const a = step / 9 + seed;
  return {
    lat: center[0] + 0.004 * Math.sin(a) + 0.0015 * Math.sin(a * 3.1),
    lng: center[1] + 0.006 * Math.cos(a * 0.8) + 0.002 * Math.sin(a * 2.3),
  };
}

/** Firmware each demo cab reports: 1.2.0 except the cell-only cab, which runs 1.0.0 like the pilot cab in the field. */
export function demoFirmware(cab: { firmware: string }) {
  return cab.firmware;
}

/**
 * The heartbeat a demo cab sends (POST /api/devices/heartbeat), in its firmware's format.
 * 1.0.0: no trigger, no sync state, signal in signalStrength whatever its unit.
 */
export function demoHeartbeat(
  cab: DemoCab,
  index: number,
  now: Date,
  extra: {
    currentLoopId: string | null;
    uptimeSeconds: number;
    location: Record<string, unknown>;
    safetyChecksum?: string | null;
    /** Keep these stable between heartbeats (a new lastSyncedAt is a new sync to the server). */
    lastSyncedAt?: Date | null;
    syncSince?: Date | null;
    failedLoopId?: string | null;
  },
) {
  const common = {
    serialNumber: cab.serial,
    firmwareVersion: cab.firmware,
    ipAddress: `10.20.0.${index + 10}`,
    storageFreeMb: 18_000 - index * 900,
    currentLoopId: extra.currentLoopId,
    cpuTemp: 51,
    uptimeSeconds: extra.uptimeSeconds,
    memoryUsedPercent: 42,
    playerStatus: cab.playerStatus,
    networkType: "4g",
    location: extra.location,
  };
  if (cab.firmware === "1.0.0") {
    return { ...common, signalStrength: cab.signal.dbm ?? cab.signal.percent };
  }
  const minutes = (value: number) => new Date(now.getTime() + value * 60_000).toISOString();
  return {
    ...common,
    signalStrength: cab.signal.dbm,
    signalPercent: cab.signal.percent,
    playerState: cab.playerState,
    playbackTrigger: cab.trigger,
    safetyChecksum: extra.safetyChecksum ?? null,
    sync: cab.sync
      ? {
          state: cab.sync.state,
          error: cab.sync.error,
          failedLoopId: cab.sync.state === "failed" ? extra.failedLoopId ?? null : null,
          since: extra.syncSince?.toISOString() ?? minutes(-cab.sync.sinceMinutesAgo),
          lastSyncedAt: extra.lastSyncedAt?.toISOString() ?? minutes(-cab.sync.sinceMinutesAgo - (cab.sync.state === "ok" ? 0 : 600)),
          nextRetryAt: cab.sync.nextRetryMinutes === null ? null : minutes(cab.sync.nextRetryMinutes),
        }
      : null,
  };
}
