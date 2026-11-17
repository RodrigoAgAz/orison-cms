// npm run demo:heartbeat [-- --loop]  — posts one round of real heartbeats for the demo cabs that
// are meant to be "alive", through the HTTP API (POST /api/devices/heartbeat), like a device would.
// With --loop it repeats every 5 minutes until stopped. Each cab reports in its firmware's format
// (common.ts demoHeartbeat): 1.2.0 cabs send their player state, trigger and sync state.
// Target server: DEMO_BASE_URL, else APP_URL from .env, else http://localhost:3000.
import { DEMO_CABS, DEMO_CELL_RAW, demoHeartbeat, loadEnv, wander } from "./common";

loadEnv();

const baseUrl = (process.env.DEMO_BASE_URL ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.DEVICE_SHARED_TOKEN ?? "local-device-token";
const KEEP_STALE = new Set(["updating"]); // this cab keeps reporting old content

async function post(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(json)}`);
  }
  return json as { expectedLoopId: string | null; disabled: boolean; expectedSafetyChecksum?: string | null };
}

async function round() {
  const { prisma } = await import("@orison/db");
  const step = Math.floor(Date.now() / 300_000);
  for (const [index, cab] of DEMO_CABS.entries()) {
    if (!cab.alive) continue;
    const device = await prisma.device.findUnique({
      where: { serialNumber: cab.serial },
      select: { currentLoopId: true, createdAt: true, safetyChecksum: true, lastSyncAt: true, syncStateSince: true, syncFailedLoopId: true },
    });
    if (!device) {
      console.warn(`${cab.serial} not found; run npm run demo:seed first`);
      continue;
    }
    const position = wander(cab.center, step, index);
    const location =
      cab.scenario === "cell"
        ? // Old firmware shape: wrong top-level ids, server re-parses raw.
          { method: "cell_tower", mcc: "234", mnc: "10", lac: "215", cellId: "1617", signalStrength: -97, raw: DEMO_CELL_RAW }
        : { method: "gps", lat: position.lat, lng: position.lng, accuracyM: 9, speedKmh: 21, fixTime: new Date().toISOString() };
    const payload = demoHeartbeat(cab, index, new Date(), {
      currentLoopId: device.currentLoopId,
      uptimeSeconds: 3600 + (Math.floor(Date.now() / 1000) % 36_000),
      location,
      safetyChecksum: device.safetyChecksum,
      lastSyncedAt: device.lastSyncAt,
      syncSince: device.syncStateSince,
      failedLoopId: device.syncFailedLoopId,
    });
    let result = await post(payload);
    let synced = "";
    if (result.expectedLoopId && result.expectedLoopId !== device.currentLoopId && !KEEP_STALE.has(cab.scenario)) {
      // Simulate the cab syncing straight away (as firmware 1.1.0+ does on expectedLoopId change).
      const syncedAt = new Date().toISOString();
      const sync = "sync" in payload && payload.sync ? { ...payload.sync, state: "ok", error: null, since: syncedAt, lastSyncedAt: syncedAt, nextRetryAt: null } : undefined;
      result = await post({ ...payload, currentLoopId: result.expectedLoopId, ...(sync ? { sync } : {}) });
      synced = " (synced)";
    }
    console.log(`${cab.serial} -> expected ${result.expectedLoopId ?? "none"}${synced}${result.disabled ? " [paused]" : ""}`);
  }
  await prisma.$disconnect();
}

async function main() {
  await round();
  if (process.argv.includes("--loop")) {
    setInterval(() => round().catch((error) => console.error(error)), 300_000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
