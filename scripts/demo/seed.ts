// npm run demo:seed — builds an idempotent demo fleet in the local database.
// Demo-only code: lives outside apps/ and is never imported by the app.
//
// - 2 groups, 8 cabs around central London in a mix of states, as firmware 1.2.0 reports them
//   (player state, trigger, sync state, signal) except one cab on firmware 1.0.0 like the pilot cab
// - 24h+ of heartbeat history (so onlineSince / hoursOnlineToday / timeline / trail have data)
// - 3 published pre-built loops made from ffmpeg test videos pushed through the real upload
//   pipeline (lib/loops.ts processUploadedLoop), and one ten-slot rotation of test adverts and
//   fillers built and compiled by the real publisher (lib/loop-publish.ts), as staff make them
// - routing: fleet -> Ten-slot rotation, West End group follows the fleet, City group -> Theatre,
//   DEMO-CAB-03 has a cab override -> Portrait clip
// - the last 24 h of playback log for the cabs that were online, in each cab's firmware format
//   (lib/playback-metrics.ts), so analytics, the dashboard and the CSV export have data
//
// Re-running resets the demo cabs' heartbeats, states and playback log; loops are created once.
// Statuses decay with time: run `npm run demo:heartbeat` (against a running server) to keep the
// "alive" cabs online.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { randomUUID } from "node:crypto";

import { DEMO_CABS, DEMO_CELL, DEMO_CELL_RAW, DEMO_GROUPS, DEMO_LOOPS, DEMO_ROTATION, demoFirmware, loadEnv, wander, webRoot, type DemoCab } from "./common";

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


type Prisma = typeof import("@orison/db")["prisma"];

async function makeClip(dir: string, spec: { key: string; label: string; seconds: number; color: string }) {
  const out = path.join(dir, `${spec.key}.mp4`);
  const base = [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${spec.color}:s=1280x800:r=30:d=${spec.seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${300 + spec.seconds * 7}:sample_rate=48000:duration=${spec.seconds}`,
  ];
  const encode = ["-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", out];
  try {
    await execFileAsync("ffmpeg", [...base, "-vf", `drawtext=text='${spec.label}':fontcolor=white:fontsize=90:x=(w-tw)/2:y=(h-th)/2`, ...encode]);
  } catch {
    await execFileAsync("ffmpeg", [...base, ...encode]);
  }
  return out;
}

/**
 * The ten-slot rotation, made the way staff make one: assets through the upload processing,
 * slots saved with the builder's rules, compiled and published by the desktop publisher.
 */
async function ensureRotationLoop(prisma: Prisma, admin: { id: string; name: string | null }) {
  const existing = await prisma.loop.findFirst({
    where: { name: DEMO_ROTATION.name, status: "PUBLISHED", compiledContentKey: { not: null } },
    orderBy: { publishedAt: "desc" },
  });
  if (existing) {
    console.log(`loop exists: ${DEMO_ROTATION.name} (${existing.id})`);
    return existing.id;
  }
  const media = await import("../../apps/web/src/lib/media");
  const loops = await import("../../apps/web/src/lib/loops");
  const publisher = await import("../../apps/web/src/lib/loop-publish");
  const dir = await mkdtemp(path.join(os.tmpdir(), "orison-demo-rotation-"));
  const assetIds: Record<string, string> = {};
  try {
    for (const [category, specs] of [["ADVERTISEMENT", DEMO_ROTATION.adverts], ["FILLER_BRANDED", DEMO_ROTATION.fillers]] as const) {
      for (const spec of specs) {
        const file = await makeClip(dir, spec);
        const id = randomUUID().replace(/-/g, "");
        const keys = media.assetKeysFor(id, "video");
        await prisma.asset.create({
          data: { id, filename: `Demo ${spec.label}.mp4`, s3Key: keys.s3Key, thumbnailKey: keys.thumbnailKey, mimeType: "video/mp4", fileSize: 0, category, status: "PROCESSING", metadata: { advertiser: "Demo" } },
        });
        await media.processAssetUpload(id, file);
        const asset = await prisma.asset.findUniqueOrThrow({ where: { id } });
        if (asset.status !== "READY") throw new Error(`demo asset ${spec.label} failed: ${asset.errorMessage}`);
        assetIds[spec.key] = id;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const seconds = Object.fromEntries([...DEMO_ROTATION.adverts, ...DEMO_ROTATION.fillers].map((spec) => [spec.key, spec.seconds]));
  const loop = await loops.createLoopDraft(DEMO_ROTATION.name);
  await loops.saveSlots(
    loop.id,
    DEMO_ROTATION.slots.map((keys, position) => {
      let at = 0;
      return {
        position,
        contents: keys.map((key, orderInSlot) => {
          const content = { assetId: assetIds[key], orderInSlot, startTimeMs: at, durationMs: seconds[key] * 1000, contentType: (orderInSlot === 0 ? "ADVERTISEMENT" : "FILLER") as "ADVERTISEMENT" | "FILLER" };
          at += content.durationMs;
          return content;
        }),
      };
    }),
  );
  await publisher.startLoopPublish(loop.id, admin);
  for (let wait = 0; wait < 600; wait += 1) {
    const row = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
    if (!row.publishJobId) {
      if (row.status !== "PUBLISHED") throw new Error(`publishing ${DEMO_ROTATION.name} failed: ${row.publishError}`);
      console.log(`loop published: ${DEMO_ROTATION.name} (${loop.id}, ${row.durationMs}ms)`);
      return loop.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`publishing ${DEMO_ROTATION.name} timed out`);
}

// --- playback log ------------------------------------------------------------------------------

type Item = { startMs: number; durationMs: number; type: string; contentType: "ADVERTISEMENT" | "FILLER" | null; assetId: string | null; slot: number | null };
type Timeline = { loopId: string; totalMs: number; slotCount: number; items: Item[]; stillAsset: (slot: number) => string | null; advertOf: (slot: number) => string | null };

async function timelineOf(prisma: Prisma, loopId: string | null): Promise<Timeline | null> {
  if (!loopId) return null;
  const loop = await prisma.loop.findUnique({ where: { id: loopId }, select: { manifestKey: true } });
  if (!loop?.manifestKey) return null;
  const storage = await import("../../apps/web/src/lib/storage");
  const manifest = JSON.parse((await storage.readObject(loop.manifestKey)).toString("utf8"));
  const slots: Array<{ position: number; staticImageAssetId?: string | null; contents: Array<{ type: string; assetId: string; startTimeMs: number; durationMs: number; absoluteStartMs?: number }> }> = manifest.slots ?? [];
  const items: Item[] = slots.flatMap((slot) =>
    slot.contents.map((c) => ({
      startMs: c.absoluteStartMs ?? slot.position * 60_000 + c.startTimeMs,
      durationMs: c.durationMs,
      type: c.type,
      contentType: c.type === "ADVERTISEMENT" ? "ADVERTISEMENT" : "FILLER",
      assetId: c.assetId,
      slot: slot.position,
    })),
  );
  const totalMs = manifest.totalDurationMs;
  return {
    loopId,
    totalMs,
    slotCount: slots.length,
    items: items.length ? items.sort((a, b) => a.startMs - b.startMs) : [{ startMs: 0, durationMs: totalMs, type: "LOOP_VIDEO", contentType: null, assetId: null, slot: null }],
    stillAsset: (slot) => slots[slot]?.staticImageAssetId ?? null,
    advertOf: (slot) => slots[slot]?.contents.find((c) => c.type === "ADVERTISEMENT")?.assetId ?? null,
  };
}

/** Deterministic pseudo-random numbers (the same demo data on every run). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * The playback log a cab would have written while online in [from, to): firmware 1.2.0 logs each
 * item when it leaves the screen with the time it was shown (eventId set, measured); 1.0.0 logs
 * when things start, every still as an ADVERTISEMENT and every play as complete (no eventId).
 */
function playbackRows(cab: DemoCab, deviceId: string, timeline: Timeline, from: number, to: number, seed: number) {
  const rows: Array<Record<string, unknown>> = [];
  const next = random(seed);
  const old = cab.firmware === "1.0.0";
  const row = (at: number, fields: Record<string, unknown>) =>
    rows.push({
      deviceId, deviceSerial: cab.serial, loopId: timeline.loopId, playedAt: new Date(at), eventId: old ? null : randomUUID(),
      slotPosition: null, contentType: null, assetId: null, playbackType: null, eventName: null, journeyId: null, completedFull: true, ...fields,
    });
  const slotted = timeline.slotCount > 0;
  const stills = (start: number, end: number, mode: "idle") => {
    const period = slotted ? 60_000 : 600_000;
    for (let k = 0, at = start; at < end; k += 1, at += period) {
      const shown = Math.min(period, end - at);
      const slot = slotted ? k % timeline.slotCount : null;
      if (old) {
        row(at, { slotPosition: slot, contentType: "ADVERTISEMENT", playbackType: "ADVERTISEMENT", assetId: slot === null ? null : timeline.stillAsset(slot) ?? timeline.advertOf(slot), mode, playerState: "IDLE", durationMs: 60_000 });
      } else if (shown >= 1000) {
        row(at, { slotPosition: slot, playbackType: "STATIC_IMAGE", assetId: slot === null ? null : timeline.stillAsset(slot), mode, playerState: "IDLE", durationMs: shown, completedFull: shown >= period - 500 });
      }
    }
  };
  const loopPlays = (start: number, end: number, mode: "journey" | "continuous", journeyId: string | null) => {
    for (let pass = 0; start + pass * timeline.totalMs < end; pass += 1) {
      for (const item of timeline.items) {
        const at = start + pass * timeline.totalMs + item.startMs;
        if (at >= end) return;
        const shown = Math.min(item.durationMs, end - at);
        const fields = { slotPosition: item.slot, contentType: item.contentType, playbackType: item.type, assetId: item.assetId, mode, playerState: "JOURNEY", journeyId };
        if (old) row(at, { ...fields, durationMs: item.durationMs });
        else if (shown >= 1000) row(at, { ...fields, durationMs: Math.round(shown), completedFull: shown >= item.durationMs - 500 });
      }
    }
  };
  let t = from;
  if (cab.trigger === "always") {
    loopPlays(t, to, "continuous", null);
    return rows;
  }
  while (t < to) {
    const idle = (4 + next() * 14) * 60_000;
    stills(t, Math.min(t + idle, to), "idle");
    t += idle;
    if (t >= to) break;
    const length = Math.min((6 + next() * 30) * 60_000, to - t);
    const journeyId = `j-demo-${cab.serial}-${Math.round(t / 1000)}`;
    row(t, { eventName: "JOURNEY_START", mode: old ? "idle" : "journey", playerState: "IDLE", durationMs: 0, journeyId, locationData: { method: "gps", lat: cab.center[0], lng: cab.center[1] } });
    loopPlays(t, t + length, "journey", journeyId);
    row(t, { eventName: "JOURNEY_END", mode: "journey", playerState: "JOURNEY", durationMs: Math.round(length), journeyId, locationData: { method: "gps", lat: cab.center[0] + 0.01, lng: cab.center[1] - 0.01 } });
    t += length + 5000;
  }
  return rows;
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

  loopIds.rotation = await ensureRotationLoop(prisma, { id: admin.id, name: admin.name });

  // Routing state (written directly so re-runs do not spam the activity feed).
  const now = new Date();
  await routing.setFleetAssignment(loopIds.rotation, admin.id, new Date(now.getTime() - 3 * 3600_000));
  await prisma.deviceGroup.update({
    where: { id: groups[0].id },
    data: { assignedLoopId: null, assignmentAt: new Date(now.getTime() - 2 * 3600_000), assignedBy: admin.id },
  });
  await prisma.deviceGroup.update({
    where: { id: groups[1].id },
    data: { assignedLoopId: loopIds.theatre, assignmentAt: new Date(now.getTime() - 2 * 3600_000), assignedBy: admin.id },
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
    await prisma.playbackLog.deleteMany({ where: { deviceId: device.id } });

    const expected = routing.resolveDeviceLoop({ groupId, overrideLoopId }, snapshotBefore).loop;
    // The "updating" cab still plays what it had before its group changed: its download keeps failing.
    const reportedLoopId =
      cab.scenario === "never" ? null : cab.scenario === "updating" ? loopIds.spring : expected?.id ?? null;

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
          // As each firmware sends it: 1.2.0 only dBm (null when unknown); 1.0.0 whatever it has.
          signalStrength: cab.firmware === "1.0.0" ? cab.signal.dbm ?? cab.signal.percent : cab.signal.dbm === null ? null : cab.signal.dbm - (step % 6),
          ...(cab.firmware === "1.0.0"
            ? {}
            : { signalPercent: cab.signal.percent, playerState: cab.playerState, playbackTrigger: cab.trigger, syncState: cab.sync?.state ?? null, syncError: cab.sync?.error ?? null }),
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
        lastSyncAt: last ? new Date(now.getTime() - ((cab.sync?.sinceMinutesAgo ?? 180) + (cab.sync?.state === "failed" ? 600 : 0)) * 60_000) : null,
        firmwareVersion: last ? demoFirmware(cab) : null,
        // The latest state as the heartbeat route keeps it on the Device row (list pages read it).
        playerStatus: last ? cab.playerStatus : null,
        playerState: last && cab.firmware !== "1.0.0" ? cab.playerState : null,
        playbackTrigger: last && cab.firmware !== "1.0.0" ? cab.trigger : null,
        signalDbm: last ? cab.signal.dbm : null,
        signalPercent: last ? cab.signal.percent : null,
        networkType: last ? "4g" : null,
        uptimeSeconds: last?.uptimeSeconds ?? null,
        statusReportedAt: last?.receivedAt ?? null,
        syncState: last && cab.sync ? cab.sync.state : null,
        syncError: last && cab.sync ? cab.sync.error : null,
        syncFailedLoopId: last && cab.sync?.state === "failed" ? expected?.id ?? null : null,
        syncStateSince: last && cab.sync ? new Date(now.getTime() - cab.sync.sinceMinutesAgo * 60_000) : null,
        syncNextRetryAt: last && cab.sync?.nextRetryMinutes != null ? new Date(now.getTime() + cab.sync.nextRetryMinutes * 60_000) : null,
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
    // Playback log for the last 24 h the cab was online (a paused cab stopped playing 3 h ago).
    const timeline = await timelineOf(prisma, reportedLoopId);
    let plays = 0;
    if (timeline) {
      const dayAgo = now.getTime() - 24 * 3600_000;
      for (const [startAgo, endAgo] of runs) {
        const from = Math.max(now.getTime() - startAgo * 60_000, dayAgo);
        const to = now.getTime() - (cab.scenario === "paused" ? Math.max(endAgo, 180) : endAgo) * 60_000;
        if (to <= from) continue;
        const playback = playbackRows(cab, device.id, timeline, from, to, index * 7919 + startAgo);
        for (let at = 0; at < playback.length; at += 2000) {
          await prisma.playbackLog.createMany({ data: playback.slice(at, at + 2000) as never });
        }
        plays += playback.length;
      }
    }
    console.log(`cab ${cab.serial} ${cab.plate}: ${cab.scenario}, firmware ${cab.firmware}, ${rows.length} heartbeats, ${plays} playback rows`);
  }

  console.log("\nDemo fleet ready. Keep cabs alive with: npm run demo:heartbeat (server must be running)");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
