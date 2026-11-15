// npm run demo:seed — builds an idempotent demo fleet in the local database.
// Demo-only code: lives outside apps/ and is never imported by the app.
//
// - 2 groups, 8 cabs around central London in a mix of states
// - 24h+ of heartbeat history (so onlineSince / hoursOnlineToday / timeline / trail have data)
// - 3 published loops made from ffmpeg test videos pushed through the real upload pipeline
//   (lib/loops.ts processUploadedLoop: transcode -> manifest -> storage -> poster)
// - routing: fleet -> Spring, West End group -> Theatre, City group follows the fleet,
//   DEMO-CAB-03 has a cab override -> Portrait clip
//
// Re-running resets the demo cabs' heartbeats and states; loops are created only once.
// Statuses decay with time: run `npm run demo:heartbeat` (against a running server) to keep the
// "alive" cabs online.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DEMO_CABS, DEMO_CELL, DEMO_CELL_RAW, DEMO_GROUPS, DEMO_LOOPS, demoFirmware, loadEnv, wander, webRoot } from "./common";

loadEnv();
// Local storage lives under <cwd>/tmp/storage; the Next server runs from apps/web.
process.chdir(webRoot);

const execFileAsync = promisify(execFile);
const HEARTBEAT_MS = 5 * 60 * 1000;

async function makeTestVideo(dir: string, spec: (typeof DEMO_LOOPS)[number]) {
  const out = path.join(dir, `${spec.key}.${spec.ext}`);
  const [w, h] = spec.size.split("x").map(Number);
  const fontSize = Math.round(Math.min(w, h) / 9);
  const base = [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${spec.color}:s=${spec.size}:r=30:d=8`,
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=8",
  ];
  const encode = ["-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out];
  const text =
    `drawtext=text='${spec.label}':fontcolor=white:fontsize=${fontSize}:x=(w-tw)/2:y=(h-th)/2-${fontSize},` +
    `drawtext=text='%{eif\\:t\\:d}s':fontcolor=0xffd166:fontsize=${fontSize}:x=(w-tw)/2:y=(h-th)/2+${fontSize}`;
  const moving = `drawbox=x='mod(t*200,iw)':y=ih-60:w=60:h=40:color=0xffd166:t=fill`;
  try {
    await execFileAsync("ffmpeg", [...base, "-vf", `${moving},${text}`, ...encode]);
  } catch {
    // No fonts available: still produce a moving test pattern.
    await execFileAsync("ffmpeg", [...base, "-vf", moving, ...encode]);
  }
  return out;
}

async function main() {
  const { prisma } = await import("@orison/db");
  const loops = await import("../../apps/web/src/lib/loops");
  const routing = await import("../../apps/web/src/lib/loop-routing");

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!admin) {
    throw new Error("No admin user found. Run `npm run db:seed` first.");
  }

  // Groups
  const groups = [];
  for (const spec of DEMO_GROUPS) {
    groups.push(
      await prisma.deviceGroup.upsert({
        where: { name: spec.name },
        update: { description: spec.description },
        create: { name: spec.name, description: spec.description },
      }),
    );
  }
  console.log(`groups: ${groups.map((g) => g.name).join(", ")}`);

  // Loops through the real upload pipeline (only when missing).
  const loopIds: Record<string, string> = {};
  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-demo-"));
  try {
    for (const spec of DEMO_LOOPS) {
      const existing = await prisma.loop.findFirst({
        where: { name: spec.name, status: "PUBLISHED", compiledVideoKey: { not: null } },
        orderBy: { publishedAt: "desc" },
      });
      if (existing) {
        loopIds[spec.key] = existing.id;
        console.log(`loop exists: ${spec.name} (${existing.id})`);
        continue;
      }
      const uploadDir = await mkdtemp(path.join(os.tmpdir(), "orison-demo-upload-"));
      const file = await makeTestVideo(uploadDir, spec);
      const loop = await loops.createPendingUploadLoop({ name: spec.name, pendingTarget: null });
      await loops.processUploadedLoop({
        loopId: loop.id,
        originalFilename: path.basename(file),
        tempFilePath: file,
        tempDir: uploadDir,
        publishedBy: { id: admin.id, name: admin.name },
      });
      const after = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
      if (after.status !== "PUBLISHED") {
        throw new Error(`Pipeline failed for ${spec.name}: ${after.publishError}`);
      }
      loopIds[spec.key] = loop.id;
      console.log(`loop published: ${spec.name} (${loop.id}, ${after.durationMs}ms)`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // Routing state (written directly so re-runs do not spam the activity feed).
  const now = new Date();
  await routing.setFleetAssignment(loopIds.spring, admin.id, new Date(now.getTime() - 3 * 3600_000));
  await prisma.deviceGroup.update({
    where: { id: groups[0].id },
    data: { assignedLoopId: loopIds.theatre, assignmentAt: new Date(now.getTime() - 2 * 3600_000), assignedBy: admin.id },
  });
  await prisma.deviceGroup.update({
    where: { id: groups[1].id },
    data: { assignedLoopId: null, assignmentAt: new Date(now.getTime() - 2 * 3600_000), assignedBy: admin.id },
  });

  // Cell tower cache entry for the cell-only cab.
  const cellKey = { radio: DEMO_CELL.radio, mcc: DEMO_CELL.mcc, mnc: DEMO_CELL.mnc, lac: DEMO_CELL.tac, cellId: DEMO_CELL.cellId };
  await prisma.cellTowerLocation.upsert({
    where: { radio_mcc_mnc_lac_cellId: cellKey },
    update: { found: true, lat: DEMO_CELL.lat, lng: DEMO_CELL.lng, accuracyM: DEMO_CELL.accuracyM, provider: "demo-seed", retryAfter: null, lookedUpAt: now },
    create: { ...cellKey, found: true, lat: DEMO_CELL.lat, lng: DEMO_CELL.lng, accuracyM: DEMO_CELL.accuracyM, provider: "demo-seed" },
  });

  // Cabs
  const snapshotBefore = await routing.getLoopRoutingSnapshot();
  for (const [index, cab] of DEMO_CABS.entries()) {
    const groupId = cab.group === null ? null : groups[cab.group].id;
    const overrideLoopId = cab.scenario === "override" ? loopIds.portrait : null;
    const createdAt = new Date(now.getTime() - (40 + index * 9) * 24 * 3600_000);
    const device = await prisma.device.upsert({
      where: { serialNumber: cab.serial },
      update: {},
      create: { serialNumber: cab.serial, createdAt },
    });
    await prisma.deviceHeartbeat.deleteMany({ where: { deviceId: device.id } });

    const expected = routing.resolveDeviceLoop({ groupId, overrideLoopId }, snapshotBefore).loop;
    const reportedLoopId =
      cab.scenario === "never" ? null : cab.scenario === "updating" ? loopIds.theatre : expected?.id ?? null;

    // Heartbeat runs as [startMinutesAgo, endMinutesAgo].
    const runs: Array<[number, number]> =
      cab.scenario === "never"
        ? []
        : cab.scenario === "offline"
          ? [[33 * 60, 20 * 60]]
          : cab.scenario === "gappy"
            ? [[22 * 60, 13 * 60], [9 * 60, 0]]
            : cab.scenario === "cell"
              ? [[27 * 60, 0]]
              : [[(5 + index) * 60, 0]];

    const rows = [];
    let step = 0;
    for (const [startAgo, endAgo] of runs) {
      for (let t = now.getTime() - startAgo * 60_000; t <= now.getTime() - endAgo * 60_000; t += HEARTBEAT_MS) {
        const receivedAt = new Date(t);
        const position = wander(cab.center, step, index);
        const uptimeSeconds = Math.round((t - (now.getTime() - startAgo * 60_000)) / 1000) + 90;
        const locationData =
          cab.scenario === "cell"
            ? {
                method: "cell_tower",
                mcc: "234", mnc: "10", lac: "215", cellId: "1617", // what old firmware wrongly sends
                signalStrength: -97,
                raw: DEMO_CELL_RAW,
                resolved: { lat: DEMO_CELL.lat, lng: DEMO_CELL.lng, accuracyM: DEMO_CELL.accuracyM, source: "cell", at: receivedAt.toISOString(), provider: "demo-seed" },
              }
            : {
                method: "gps",
                lat: position.lat, lng: position.lng, accuracyM: 8, speedKmh: 18,
                fixTime: receivedAt.toISOString(),
                resolved: { lat: position.lat, lng: position.lng, accuracyM: 8, source: "gps", at: receivedAt.toISOString(), provider: null },
              };
        rows.push({
          deviceId: device.id,
          receivedAt,
          ipAddress: `10.20.0.${index + 10}`,
          firmwareVersion: demoFirmware(cab),
          storageFreeMb: 18_000 - index * 900,
          currentLoopId: reportedLoopId,
          cpuTemp: 48 + (step % 7),
          uptimeSeconds,
          memoryUsedPercent: 41,
          playerStatus: cab.playerStatus,
          networkType: "4g",
          signalStrength: -85 - (step % 12),
          locationData,
        });
        step += 1;
      }
    }
    if (rows.length > 0) {
      await prisma.deviceHeartbeat.createMany({ data: rows });
    }
    const last = rows[rows.length - 1];
    const lastLocation = last?.locationData.resolved;

    await prisma.device.update({
      where: { id: device.id },
      data: {
        cabLicenseNumber: cab.plate,
        driverName: cab.driver,
        groupId,
        isActive: true,
        isDisabled: cab.scenario === "paused",
        disabledReason: cab.scenario === "paused" ? "Cab in for its MOT" : null,
        overrideLoopId,
        overrideAt: overrideLoopId ? new Date(now.getTime() - 3600_000) : null,
        overrideBy: overrideLoopId ? admin.id : null,
        currentLoopId: reportedLoopId,
        lastHeartbeatAt: last?.receivedAt ?? null,
        lastSyncAt: last?.receivedAt ?? null,
        firmwareVersion: last ? demoFirmware(cab) : null,
        storageFreeMb: last?.storageFreeMb ?? null,
        ipAddress: last?.ipAddress ?? null,
        notes: `Demo cab (${cab.scenario})`,
        locationLat: lastLocation?.lat ?? null,
        locationLng: lastLocation?.lng ?? null,
        locationAccuracyM: lastLocation?.accuracyM ?? null,
        locationSource: lastLocation?.source ?? null,
        locationAt: last?.receivedAt ?? null,
      },
    });
    console.log(`cab ${cab.serial} ${cab.plate}: ${cab.scenario}, ${rows.length} heartbeats`);
  }

  console.log("\nDemo fleet ready. Keep cabs alive with: npm run demo:heartbeat (server must be running)");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
