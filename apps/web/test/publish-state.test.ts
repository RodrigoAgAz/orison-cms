import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contactSheetTimes, dueRetired, storageKeyFromUrl } from "../src/lib/loop-publish";
import { isAlreadyLoopFormat, videoFilter } from "../src/lib/media-format";
import {
  PUBLISH_STALE_MS,
  blockedByPublish,
  describeProgress,
  isHeartbeatStale,
  parsePublishProgress,
  progressFraction,
  publishJobView,
} from "../src/lib/publish-state";

const now = new Date("2026-11-17T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("publish job state", () => {
  it("is idle without a job", () => {
    assert.deepEqual(publishJobView({ publishJobId: null, publishHeartbeatAt: null, publishProgress: null }, now), { kind: "idle" });
  });

  it("is running while the heartbeat is fresh, and interrupted once it is stale", () => {
    const progress = { stage: "encoding", done: 3, total: 10, startedAt: ago(60_000).toISOString() };
    const running = publishJobView({ publishJobId: "j1", publishHeartbeatAt: ago(5_000), publishProgress: progress }, now);
    assert.equal(running.kind, "running");
    assert.equal(running.kind === "running" && running.progress?.done, 3);
    const stale = publishJobView({ publishJobId: "j1", publishHeartbeatAt: ago(PUBLISH_STALE_MS + 1), publishProgress: progress }, now);
    assert.equal(stale.kind, "interrupted");
    assert.equal(publishJobView({ publishJobId: "j1", publishHeartbeatAt: null, publishProgress: null }, now).kind, "interrupted");
  });

  it("refuses pause, delete and target changes only while running", () => {
    const running = publishJobView({ publishJobId: "j1", publishHeartbeatAt: ago(1_000), publishProgress: null }, now);
    assert.match(blockedByPublish(running, "delete")!, /being published.*delete it/);
    assert.match(blockedByPublish(running, "pause")!, /pause it/);
    const interrupted = publishJobView({ publishJobId: "j1", publishHeartbeatAt: ago(PUBLISH_STALE_MS * 2), publishProgress: null }, now);
    assert.equal(blockedByPublish(interrupted, "delete"), null);
    assert.equal(blockedByPublish({ kind: "idle" }, "delete"), null);
  });

  it("reads progress defensively and describes it", () => {
    assert.equal(parsePublishProgress({ stage: "nonsense" }), null);
    assert.equal(parsePublishProgress("x"), null);
    const progress = parsePublishProgress({ stage: "encoding", done: 4, total: 23, startedAt: "2026-11-17T00:00:00Z", pendingKeys: ["a", 1] });
    assert.deepEqual(progress?.pendingKeys, ["a"]);
    assert.equal(describeProgress(progress), "Encoding (4 of 23)");
    assert.equal(describeProgress(null), "Starting");
    const fraction = progressFraction(progress);
    assert.ok(fraction > 0.1 && fraction < 0.75);
    assert.ok(progressFraction({ stage: "going-live", startedAt: "" }) >= 0.97);
  });

  it("treats a missing or unparsable heartbeat as stale", () => {
    assert.equal(isHeartbeatStale(null, now), true);
    assert.equal(isHeartbeatStale("garbage", now), true);
    assert.equal(isHeartbeatStale(ago(1000).toISOString(), now), false);
  });
});

describe("superseded objects", () => {
  it("are deleted only after their grace period", () => {
    const entries = [
      { key: "old", retiredAt: ago(7 * 3600_000).toISOString() },
      { key: "recent", retiredAt: ago(60_000).toISOString() },
    ];
    const { due, keep } = dueRetired(entries, now);
    assert.deepEqual(due.map((entry) => entry.key), ["old"]);
    assert.deepEqual(keep.map((entry) => entry.key), ["recent"]);
    assert.equal(dueRetired(entries, now, 0).due.length, 2);
  });

  it("are recognised from the URLs this app writes", () => {
    assert.equal(storageKeyFromUrl("https://cms.example/api/storage/loops/l1/a-static-fallback.jpg"), "loops/l1/a-static-fallback.jpg");
    assert.equal(storageKeyFromUrl("https://elsewhere.example/x.jpg"), null);
    assert.equal(storageKeyFromUrl(null), null);
  });
});

describe("poster contact sheet", () => {
  it("takes a moment into each distinct advert, in slot order, up to four", () => {
    const slot = (position: number, assetId: string, durationMs = 12_000) => ({
      position,
      contents: [
        { contentType: "ADVERTISEMENT", assetId, startTimeMs: 0, durationMs },
        { contentType: "FILLER", assetId: "f", startTimeMs: durationMs, durationMs: 60_000 - durationMs },
      ],
    });
    assert.deepEqual(
      contactSheetTimes([slot(1, "b"), slot(0, "a"), slot(2, "a"), slot(3, "c", 1_000), slot(4, "d"), slot(5, "e")], 60_000),
      [1_000, 61_000, 180_500, 241_000],
    );
  });
});

describe("loop format", () => {
  const frame = { width: 1280, height: 800 };
  const standard = {
    width: 1280,
    height: 800,
    videoCodec: "h264",
    audioCodec: "aac",
    pixFmt: "yuv420p",
    rotation: 0,
    colorTransfer: null,
    frameRate: 30,
    avgFrameRate: 30,
    audioChannels: 2,
    audioSampleRate: 48_000,
    maxKeyframeIntervalMs: 2_000,
  };
  it("lets only a file already in the loop format skip re-encoding", () => {
    assert.equal(isAlreadyLoopFormat(standard, frame), true);
    assert.equal(isAlreadyLoopFormat({ ...standard, frameRate: 60, avgFrameRate: 60 }, frame), false);
    assert.equal(isAlreadyLoopFormat({ ...standard, audioChannels: 6 }, frame), false);
    assert.equal(isAlreadyLoopFormat({ ...standard, audioSampleRate: 44_100 }, frame), false);
    assert.equal(isAlreadyLoopFormat({ ...standard, maxKeyframeIntervalMs: 30_000 }, frame), false);
    assert.equal(isAlreadyLoopFormat({ ...standard, colorTransfer: "arib-std-b67" }, frame), false);
    assert.equal(isAlreadyLoopFormat({ ...standard, width: 1920, height: 1080 }, frame), false);
  });
  it("pads to the frame for compiles and never pads or enlarges library copies", () => {
    const compile = videoFilter({ size: frame, mode: "frame", hdr: false, fps: 30, holdLastFrame: true });
    assert.match(compile, /^scale=1280:800:force_original_aspect_ratio=decrease/);
    assert.match(compile, /fps=30/);
    assert.match(compile, /pad=1280:800/);
    assert.match(compile, /tpad=stop_mode=clone:stop=-1$/);
    const library = videoFilter({ size: { width: 1920, height: 1080 }, mode: "within", hdr: true });
    assert.match(library, /min\(1920,iw\)/);
    assert.doesNotMatch(library, /pad=/);
    assert.match(library, /tonemap=/);
  });
});
