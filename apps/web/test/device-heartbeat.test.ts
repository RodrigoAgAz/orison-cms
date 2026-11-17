import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { heartbeatSchema } from "@orison/shared";

import { applyHeartbeat, readSignal } from "../src/lib/device-heartbeat";
import { hasPassengerDetection, screenActivityLabel, summarizeSync } from "../src/lib/device-status";
import { rebaseStorageUrl, rebaseStorageUrlsDeep } from "../src/lib/storage-urls";

const now = new Date("2026-11-17T10:00:00Z");
const previous = {
  id: "dev1",
  serialNumber: "RodrigoCab",
  currentLoopId: "loopA",
  lastSyncAt: null,
  syncState: null,
  syncFailedLoopId: null,
};

// What firmware 1.0.0's health monitor sends (nmcli fallback: signal is a percentage).
const oldFull = heartbeatSchema.parse({
  serialNumber: "RodrigoCab",
  ipAddress: "10.0.0.5",
  firmwareVersion: "1.0.0",
  storageFreeMb: 40000,
  currentLoopId: "loopA",
  cpuTemp: 51.2,
  uptimeSeconds: 3600,
  memoryUsedPercent: 41.2,
  playerStatus: "unknown",
  networkType: "4g",
  signalStrength: 62,
  location: { method: "network_manager", operator: "EE", signalStrength: 62 },
});

describe("signal", () => {
  it("reads old firmware's positive signalStrength as a percentage", () => {
    assert.deepEqual(readSignal(oldFull), { signalPercent: 62, signalDbm: null });
  });
  it("reads negative values as dBm and prefers signalPercent", () => {
    assert.deepEqual(readSignal({ signalStrength: -95, signalPercent: 70 }), { signalPercent: 70, signalDbm: -95 });
    assert.deepEqual(readSignal({ signalStrength: -95 }), { signalPercent: null, signalDbm: -95 });
    assert.equal(readSignal({}), undefined);
  });
});

describe("applyHeartbeat", () => {
  it("keeps the latest state on the Device row for old firmware", () => {
    const { fields, activity } = applyHeartbeat(oldFull, previous, now);
    assert.equal(fields.playerStatus, "unknown");
    assert.equal(fields.signalPercent, 62);
    assert.equal(fields.uptimeSeconds, 3600);
    assert.equal(fields.statusReportedAt, now);
    assert.equal(fields.syncState, undefined);
    assert.deepEqual(activity, []);
  });

  it("does not wipe player state with the sync agent's short heartbeat", () => {
    const short = heartbeatSchema.parse({ serialNumber: "RodrigoCab", currentLoopId: "loopA", storageFreeMb: 100 });
    const { fields } = applyHeartbeat(short, previous, now);
    assert.equal("playerStatus" in fields, false);
    assert.equal(fields.signalPercent, undefined);
  });

  it("records a loop change from old firmware as a sync", () => {
    const short = heartbeatSchema.parse({ serialNumber: "RodrigoCab", currentLoopId: "loopB" });
    const { fields, activity } = applyHeartbeat(short, previous, now, () => "Explore 1920x1080");
    assert.equal(fields.lastSyncAt, now);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].type, "DEVICE_SYNCED");
    assert.match(activity[0].message, /Explore 1920x1080/);
  });

  it("registers a cab created by its first heartbeat", () => {
    const { activity } = applyHeartbeat(oldFull, null, now);
    assert.deepEqual(
      activity.map((event) => event.type),
      ["DEVICE_REGISTERED"],
    );
  });

  it("emits SYNC_FAILED on the transition only, and DEVICE_SYNCED when lastSyncedAt advances", () => {
    const failing = heartbeatSchema.parse({
      serialNumber: "RodrigoCab",
      currentLoopId: "loopA",
      playerStatus: "playing",
      playbackTrigger: "always",
      sync: { state: "failed", error: "No space left on device", failedLoopId: "loopB", since: "2026-11-17T09:58:00Z" },
    });
    const first = applyHeartbeat(failing, previous, now);
    assert.equal(first.fields.syncState, "failed");
    assert.equal(first.fields.syncError, "No space left on device");
    assert.equal(first.fields.playbackTrigger, "always");
    assert.deepEqual(first.activity.map((event) => event.type), ["SYNC_FAILED"]);

    const again = applyHeartbeat(failing, { ...previous, syncState: "failed", syncFailedLoopId: "loopB" }, now);
    assert.deepEqual(again.activity, []);

    const ok = heartbeatSchema.parse({
      serialNumber: "RodrigoCab",
      currentLoopId: "loopB",
      sync: { state: "ok", lastSyncedAt: "2026-11-17T09:59:00Z" },
    });
    const synced = applyHeartbeat(ok, { ...previous, syncState: "failed", syncFailedLoopId: "loopB" }, now);
    assert.equal(synced.fields.syncError, null);
    assert.equal(synced.fields.lastSyncAt?.toISOString(), "2026-11-17T09:59:00.000Z");
    assert.deepEqual(synced.activity.map((event) => event.type), ["DEVICE_SYNCED"]);

    const steady = applyHeartbeat(ok, { ...previous, currentLoopId: "loopB", syncState: "ok", lastSyncAt: new Date("2026-11-17T09:59:00Z") }, now);
    assert.deepEqual(steady.activity, []);
  });
});

describe("firmware 1.2.0 extras", () => {
  it("stores playerState and keeps an ok-state explanation without raising SYNC_FAILED", () => {
    const body = heartbeatSchema.parse({
      serialNumber: "RodrigoCab",
      playerStatus: "playing",
      playerState: "SAFETY",
      logQueue: { pending: 3 },
      display: { connected: true },
      sync: { state: "ok", error: "No loop is assigned to this cab (manifest 404)" },
    });
    const { fields, activity } = applyHeartbeat(body, previous, now);
    assert.equal(fields.playerState, "SAFETY");
    assert.equal(fields.syncError, "No loop is assigned to this cab (manifest 404)");
    assert.deepEqual(activity, []);
    assert.equal("logQueue" in body, false);
    assert.equal(screenActivityLabel("playing", "gpio", true, "SAFETY"), "Safety message playing");
    assert.match(summarizeSync({ currentLoopId: null, lastSyncAt: null, syncState: "ok", syncError: "nothing assigned" }, null).label, /nothing assigned/);
  });
});

describe("status wording", () => {
  it("shows sync trouble instead of 'updating' forever", () => {
    const failing = summarizeSync(
      { currentLoopId: "a", lastSyncAt: null, syncState: "failed", syncError: "HTTP 404 for loop.mp4" },
      "b",
    );
    assert.equal(failing.state, "failing");
    assert.equal(failing.error, "HTTP 404 for loop.mp4");
    assert.equal(summarizeSync({ currentLoopId: "a", lastSyncAt: null }, "b").state, "waiting");
    assert.equal(summarizeSync({ currentLoopId: "b", lastSyncAt: null, syncState: "ok" }, "b").state, "current");
  });

  it("does not talk about passengers for cabs that play continuously", () => {
    assert.equal(hasPassengerDetection("always"), false);
    assert.equal(hasPassengerDetection(null), true);
    assert.equal(screenActivityLabel("idle", "gpio", true), "Waiting for a passenger");
    assert.equal(screenActivityLabel("playing", "always", true), "Playing the loop");
    assert.equal(screenActivityLabel("playing", null, false), "Not reporting");
  });
});

describe("storage URLs follow the current origin", () => {
  it("rebases this app's /api/storage URLs only", () => {
    const origin = "https://orison-cms-production.up.railway.app";
    assert.equal(
      rebaseStorageUrl("https://cms.orisonscreens.com/api/storage/loops/l1/1.mp4", origin),
      `${origin}/api/storage/loops/l1/1.mp4`,
    );
    assert.equal(rebaseStorageUrl("https://cdn.example.com/loops/l1/1.mp4", origin), "https://cdn.example.com/loops/l1/1.mp4");
    assert.equal(rebaseStorageUrl(null, origin), null);
    const manifest = rebaseStorageUrlsDeep(
      {
        checksum: "sha256:abc",
        compiledVideoUrl: "http://localhost:3000/api/storage/loops/l1/1.mp4",
        safetyVideo: { url: "http://localhost:3000/api/storage/assets/s/content.mp4", durationMs: 8000 },
        slots: [{ staticImageUrl: "http://old.example/api/storage/assets/x/content.jpg", position: 0 }],
      },
      origin,
    );
    assert.equal(manifest.checksum, "sha256:abc");
    assert.equal(manifest.compiledVideoUrl, `${origin}/api/storage/loops/l1/1.mp4`);
    assert.equal(manifest.safetyVideo.url, `${origin}/api/storage/assets/s/content.mp4`);
    assert.equal(manifest.slots[0].staticImageUrl, `${origin}/api/storage/assets/x/content.jpg`);
    assert.equal(manifest.slots[0].position, 0);
  });
});
