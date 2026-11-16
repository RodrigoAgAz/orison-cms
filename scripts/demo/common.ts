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

export type DemoCab = {
  serial: string;
  plate: string;
  driver: string | null;
  group: 0 | 1 | null;
  scenario: "gps" | "cell" | "override" | "updating" | "offline" | "paused" | "never" | "gappy";
  center: [number, number];
  alive: boolean; // demo:heartbeat keeps these online
  playerStatus: "playing" | "silent" | "idle";
};

export const DEMO_CABS: DemoCab[] = [
  { serial: "DEMO-CAB-01", plate: "LX21 KCB", driver: "Sam Okafor", group: 0, scenario: "gps", center: [51.5101, -0.1340], alive: true, playerStatus: "playing" },
  { serial: "DEMO-CAB-02", plate: "LT19 HPR", driver: "Priya Shah", group: 0, scenario: "cell", center: [51.5154, -0.1419], alive: true, playerStatus: "idle" },
  { serial: "DEMO-CAB-03", plate: "LB70 TXI", driver: "Tom Reilly", group: 0, scenario: "override", center: [51.5033, -0.1196], alive: true, playerStatus: "playing" },
  { serial: "DEMO-CAB-04", plate: "LR68 FBN", driver: "Grace Mensah", group: 1, scenario: "updating", center: [51.5155, -0.0922], alive: true, playerStatus: "silent" },
  { serial: "DEMO-CAB-05", plate: "LK18 WQS", driver: "Dan Cohen", group: 1, scenario: "offline", center: [51.5246, -0.0786], alive: false, playerStatus: "idle" },
  { serial: "DEMO-CAB-06", plate: "LN67 ZTA", driver: "Aisha Rahman", group: null, scenario: "paused", center: [51.4975, -0.1357], alive: true, playerStatus: "idle" },
  { serial: "DEMO-CAB-07", plate: "LC22 NEW", driver: null, group: 1, scenario: "never", center: [51.5072, -0.1276], alive: false, playerStatus: "idle" },
  { serial: "DEMO-CAB-08", plate: "LV20 MRK", driver: "Joe Barnes", group: 1, scenario: "gappy", center: [51.5079, -0.0877], alive: true, playerStatus: "playing" },
];

/** Deterministic small wander around a centre (about +-600m). */
export function wander(center: [number, number], step: number, seed: number): { lat: number; lng: number } {
  const a = step / 9 + seed;
  return {
    lat: center[0] + 0.004 * Math.sin(a) + 0.0015 * Math.sin(a * 3.1),
    lng: center[1] + 0.006 * Math.cos(a * 0.8) + 0.002 * Math.sin(a * 2.3),
  };
}

/**
 * Firmware each demo cab reports. 1.1.0 reacts to the heartbeat response (changes within one
 * heartbeat); 1.0.0 is what every cab in the field runs before the rollout and only checks every
 * 30 minutes. The cell-tower cab and the cab that is slow to switch model old firmware.
 */
export function demoFirmware(cab: { scenario: string }) {
  return cab.scenario === "cell" || cab.scenario === "updating" ? "1.0.0" : "1.1.0";
}
