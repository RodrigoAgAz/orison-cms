// npm run demo:heartbeat [-- --loop]  — posts one round of real heartbeats for the demo cabs that
// are meant to be "alive", through the HTTP API (POST /api/devices/heartbeat), like a device would.
// With --loop it repeats every 5 minutes until stopped.
// Target server: DEMO_BASE_URL, else APP_URL from .env, else http://localhost:3000.
import { DEMO_CABS, DEMO_CELL_RAW, demoFirmware, loadEnv, wander } from "./common";

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
  return json as { expectedLoopId: string | null; disabled: boolean };
}

async function round() {
  const { prisma } = await import("@orison/db");
  const step = Math.floor(Date.now() / 300_000);
  for (const [index, cab] of DEMO_CABS.entries()) {
    if (!cab.alive) continue;
    const device = await prisma.device.findUnique({
      where: { serialNumber: cab.serial },
      select: { currentLoopId: true, createdAt: true },
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
    const payload = {
      serialNumber: cab.serial,
      firmwareVersion: demoFirmware(cab),
      storageFreeMb: 18_000 - index * 900,
      currentLoopId: device.currentLoopId,
      cpuTemp: 51,
      uptimeSeconds: 3600 + (Math.floor(Date.now() / 1000) % 36_000),
      memoryUsedPercent: 42,
      playerStatus: cab.playerStatus,
      networkType: "4g",
      signalStrength: -88,
      location,
    };
    let result = await post(payload);
    let synced = "";
    if (result.expectedLoopId && result.expectedLoopId !== device.currentLoopId && !KEEP_STALE.has(cab.scenario)) {
      // Simulate the cab syncing straight away (as new firmware does on expectedLoopId change).
      result = await post({ ...payload, currentLoopId: result.expectedLoopId });
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
