import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  eventIdLookup,
  skipDuplicateEntries,
  toPlaybackRow,
  validatePlaybackEntries,
} from "../src/lib/playback-ingest";

const context = { deviceId: "dev1", serialNumber: "RodrigoCab", currentLoopId: "loop-now" };
const location = { method: "nmcli", signalStrength: 62 };

// What firmware 1.0.0 writes (it also sends "ts", which is ignored).
const oldStill = {
  ts: "2026-11-17T09:00:00.123456Z",
  playedAt: "2026-11-17T09:00:00.123456Z",
  slotPosition: 3,
  contentType: "ADVERTISEMENT",
  type: "ADVERTISEMENT",
  event: null,
  assetId: "asset-static",
  mode: "idle",
  state: "IDLE",
  completedFull: true,
  durationMs: 60000,
  journeyId: null,
  deviceSerial: "RodrigoCab",
  location,
};

const v12 = (eventId: string, extra: Record<string, unknown> = {}) => ({
  eventId,
  loopId: "loop-then",
  playedAt: "2026-11-17T09:01:00Z",
  type: "STATIC_IMAGE",
  contentType: null,
  assetId: null,
  mode: "continuous",
  durationMs: 11840,
  completedFull: true,
  slotPosition: 0,
  ...extra,
});

describe("per-entry validation", () => {
  it("stores valid entries and reports the invalid ones by index", () => {
    const { valid, rejected } = validatePlaybackEntries([
      oldStill,
      { ...oldStill, playedAt: "not a time" },
      v12("e1"),
      { ...oldStill, mode: "teleport" },
      "garbage",
    ]);
    assert.deepEqual(
      valid.map((item) => item.index),
      [0, 2],
    );
    assert.deepEqual(
      rejected.map((item) => item.index),
      [1, 3, 4],
    );
    assert.match(rejected[0].reason, /playedAt/);
    assert.match(rejected[1].reason, /mode/);
  });

  it("accepts mode continuous and type STATIC_IMAGE", () => {
    const { valid, rejected } = validatePlaybackEntries([v12("e1"), v12("e2", { mode: "journey", type: "ADVERTISEMENT", contentType: "ADVERTISEMENT" })]);
    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 2);
  });
});

describe("de-duplication", () => {
  it("skips entries already stored and repeats within the batch", () => {
    const { valid } = validatePlaybackEntries([v12("e1"), v12("e2"), v12("e2"), v12("e3")]);
    const { fresh, duplicates } = skipDuplicateEntries(valid, new Set(["e1"]));
    assert.deepEqual(
      fresh.map((item) => item.entry.eventId),
      ["e2", "e3"],
    );
    assert.equal(duplicates, 2);
  });

  it("always keeps old firmware entries (no eventId to recognise them by)", () => {
    const { valid } = validatePlaybackEntries([oldStill, oldStill]);
    const { fresh, duplicates } = skipDuplicateEntries(valid, new Set());
    assert.equal(fresh.length, 2);
    assert.equal(duplicates, 0);
    assert.equal(eventIdLookup(valid), null);
  });

  it("bounds the stored-entry lookup by the batch's playedAt range", () => {
    const { valid } = validatePlaybackEntries([
      v12("a", { playedAt: "2026-11-17T09:05:00Z" }),
      v12("b", { playedAt: "2026-11-17T08:00:00Z" }),
      oldStill,
    ]);
    const lookup = eventIdLookup(valid)!;
    assert.deepEqual(lookup.eventIds, ["a", "b"]);
    assert.equal(lookup.from.toISOString(), "2026-11-17T08:00:00.000Z");
    assert.equal(lookup.to.toISOString(), "2026-11-17T09:05:00.000Z");
  });
});

describe("rows", () => {
  it("attributes an entry to its own loop, else the cab's current loop", () => {
    const { valid } = validatePlaybackEntries([v12("e1"), oldStill]);
    assert.equal(toPlaybackRow(valid[0].entry, context).loopId, "loop-then");
    assert.equal(toPlaybackRow(valid[1].entry, context).loopId, "loop-now");
    assert.equal(toPlaybackRow(valid[1].entry, { ...context, currentLoopId: null }).loopId, "unknown");
  });

  it("keeps the location only on journey start/end", () => {
    const { valid } = validatePlaybackEntries([
      oldStill,
      { ...oldStill, event: "JOURNEY_START", type: null, contentType: null },
      { ...oldStill, event: "JOURNEY_END", type: null, contentType: null },
    ]);
    assert.equal(toPlaybackRow(valid[0].entry, context).locationData, undefined);
    assert.deepEqual(toPlaybackRow(valid[1].entry, context).locationData, location);
    assert.deepEqual(toPlaybackRow(valid[2].entry, context).locationData, location);
  });

  it("stores the eventId and the cab's own serial", () => {
    const { valid } = validatePlaybackEntries([v12("e9"), oldStill]);
    const rowNew = toPlaybackRow(valid[0].entry, context);
    assert.equal(rowNew.eventId, "e9");
    assert.equal(rowNew.deviceSerial, "RodrigoCab");
    assert.equal(rowNew.contentType, null);
    assert.equal(rowNew.playbackType, "STATIC_IMAGE");
    assert.equal(toPlaybackRow(valid[1].entry, context).eventId, null);
  });
});
