import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCompilePlan,
  buildSlotLoopManifest,
  draftKeyOf,
  hasUnpublishedChanges,
  legacyContentKey,
  legacyContentKeyFromManifest,
  legacyUnknownKey,
  msToFrame,
  PlanError,
  verifyCompiled,
  type CompiledProbe,
  type PlanAsset,
  type PlanSlot,
} from "../src/lib/loop-plan";
import { publishWork } from "../src/lib/publish-state";

const frame = { width: 1280, height: 800 };
const asset = (id: string, durationMs: number | null, mimeType = "video/mp4"): PlanAsset => ({
  id,
  filename: `${id}.mp4`,
  s3Key: `assets/${id}/content.mp4`,
  mimeType,
  durationMs,
  checksum: `sha256:${id}`,
  fileSize: 1000,
});
const ad30 = asset("ad30", 30_016);
const ad10 = asset("ad10", 10_000);
const filler = asset("filler", 15_000);
const still = asset("still", null, "image/jpeg");

function slots(make: (position: number) => Array<[PlanAsset, "ADVERTISEMENT" | "FILLER", number]>): PlanSlot[] {
  return Array.from({ length: 10 }, (_, position) => {
    let at = 0;
    return {
      position,
      contents: make(position).map(([a, contentType, durationMs], orderInSlot) => {
        const content = { assetId: a.id, orderInSlot, startTimeMs: at, durationMs, contentType, asset: a };
        at += durationMs;
        return content;
      }),
    };
  });
}

const standard = slots((position) =>
  position % 2 === 0
    ? [[ad30, "ADVERTISEMENT", 30_000], [filler, "FILLER", 15_000], [still, "FILLER", 15_000]]
    : [[ad10, "ADVERTISEMENT", 10_000], [filler, "FILLER", 20_000], [still, "FILLER", 30_000]],
);

describe("compile plan", () => {
  const plan = buildCompilePlan(standard, frame);

  it("puts every slot on its minute and every item on its declared time, in frames", () => {
    assert.equal(plan.totalFrames, 18_000);
    assert.equal(plan.totalDurationMs, 600_000);
    assert.equal(plan.totalAudioSamples, 600 * 48_000);
    for (let position = 0; position < 10; position += 1) {
      assert.equal(plan.items.find((item) => item.slotPosition === position)!.startFrame, position * 1800);
    }
    const second = plan.items[1];
    assert.equal(second.absoluteStartMs, 30_000);
    assert.equal(second.startFrame, 900);
    assert.equal(second.frameCount, 450);
    assert.equal(plan.items.reduce((sum, item) => sum + item.frameCount, 0), 18_000);
  });

  it("encodes each distinct (file, length) once and needs a keyframe at every item start", () => {
    // ad30@900, ad10@300, filler@450, filler@600, still@450, still@900
    assert.equal(plan.segments.length, 6);
    assert.equal(plan.items.length, 30);
    assert.deepEqual(plan.requiredKeyframes.slice(0, 7), [0, 900, 1350, 1800, 2100, 2700, 3600]);
    assert.equal(plan.segments.find((segment) => segment.assetId === "still")!.kind, "still");
    assert.equal(plan.segments[0].audioSamples, 900 * 1600);
  });

  it("records how each file fits", () => {
    assert.equal(plan.items[0].fit.kind, "exact"); // 30.016 s file, 30 s
    assert.equal(plan.items[2].fit.kind, "still");
    const odd = plan.items.find((item) => item.slotPosition === 1 && item.assetId === "filler")!;
    assert.deepEqual(odd.fit, { kind: "held", byMs: 5_000 });
  });

  it("rounds a legacy boundary that is not on a frame to the nearest frame, keeping the total", () => {
    const legacy = slots(() => [[ad10, "ADVERTISEMENT", 12_010], [filler, "FILLER", 47_990]]);
    const legacyPlan = buildCompilePlan(legacy, frame);
    assert.equal(legacyPlan.items[1].startFrame, msToFrame(12_010));
    assert.equal(legacyPlan.totalFrames, 18_000);
  });

  it("has a content key that changes only with picture or sound", () => {
    assert.equal(buildCompilePlan(standard, frame).contentKey, plan.contentKey);
    const renamed = standard.map((slot) => ({ ...slot, contents: slot.contents.map((content) => ({ ...content, asset: { ...content.asset, filename: "x" } })) }));
    assert.equal(buildCompilePlan(renamed, frame).contentKey, plan.contentKey);
    assert.notEqual(buildCompilePlan(standard, { width: 1920, height: 1080 }).contentKey, plan.contentKey);
    const changed = slots(() => [[ad10, "ADVERTISEMENT", 10_000], [filler, "FILLER", 50_000]]);
    assert.notEqual(buildCompilePlan(changed, frame).contentKey, plan.contentKey);
    const newFile = standard.map((slot) => ({ ...slot, contents: slot.contents.map((content) => ({ ...content, asset: { ...content.asset, checksum: "sha256:other" } })) }));
    assert.notEqual(buildCompilePlan(newFile, frame).contentKey, plan.contentKey);
  });

  it("refuses a loop that is not ready, naming the slot", () => {
    const broken = slots((position) => (position === 3 ? [[ad30, "ADVERTISEMENT", 30_000], [filler, "FILLER", 20_000]] : [[ad10, "ADVERTISEMENT", 10_000], [filler, "FILLER", 50_000]]));
    assert.throws(() => buildCompilePlan(broken, frame), (error: unknown) => error instanceof PlanError && /Slot 4: .*10 s short/.test(error.message));
    assert.throws(() => buildCompilePlan(standard.slice(0, 9), frame), /exactly 10 slots/);
  });
});

function goodProbe(plan: ReturnType<typeof buildCompilePlan>): CompiledProbe {
  const keyframes = new Set(plan.requiredKeyframes);
  for (let frameIndex = 0; frameIndex < plan.totalFrames; frameIndex += 60) keyframes.add(frameIndex);
  return {
    width: 1280,
    height: 800,
    frameRate: 30,
    videoCodec: "h264",
    videoProfile: "High",
    pixFmt: "yuv420p",
    audioCodec: "aac",
    audioChannels: 2,
    audioSampleRate: 48_000,
    videoFrames: 18_000,
    videoDurationMs: 600_000,
    audioDurationMs: 600_000,
    containerDurationMs: 600_000,
    keyframes: [...keyframes].sort((a, b) => a - b),
  };
}

describe("verifying the compiled file", () => {
  const plan = buildCompilePlan(standard, frame);
  it("accepts a file that matches the plan within a frame", () => {
    assert.deepEqual(verifyCompiled(plan, goodProbe(plan)), []);
    assert.deepEqual(verifyCompiled(plan, { ...goodProbe(plan), audioDurationMs: 600_021 }), []);
  });
  it("refuses one that is longer, missing keyframes, or in another format", () => {
    assert.match(verifyCompiled(plan, { ...goodProbe(plan), containerDurationMs: 623_000 }).join(), /file lasts 623.000 s, not 600.000 s/);
    assert.match(verifyCompiled(plan, { ...goodProbe(plan), keyframes: [0, 60] }).join(), /do not start on a keyframe/);
    assert.match(verifyCompiled(plan, { ...goodProbe(plan), audioChannels: 6 }).join(), /not AAC stereo 48 kHz/);
    assert.match(verifyCompiled(plan, { ...goodProbe(plan), videoFrames: 17_999 }).join(), /17999 frames/);
  });
});

describe("manifest", () => {
  const plan = buildCompilePlan(standard, frame);
  const build = (publishedAt: Date, name = "Loop") =>
    buildSlotLoopManifest({
      loop: { id: "loop1", name, targetGroupId: null },
      plan,
      slots: standard.map((slot) => ({ ...slot, staticCreative: null })),
      assetUrl: (key) => `https://cms.example/api/storage/${key}`,
      fallbackStill: { assetId: null, url: "https://cms.example/api/storage/system/still.jpg", checksum: "sha256:still", fileSizeBytes: 50 },
      safetyVideo: null,
      video: { url: "https://cms.example/api/storage/loops/loop1/v.mp4", checksum: "sha256:v", fileSizeBytes: 1_000_000, probe: goodProbe(plan) },
      publishedAt,
    });

  it("describes the compiled file fully and keeps what old players read", () => {
    const { manifest } = build(new Date("2026-11-17T00:00:00Z"));
    assert.equal(manifest.totalDurationMs, 600_000);
    assert.equal(manifest.slotCount, 10);
    assert.equal(manifest.slotDurationMs, 60_000);
    assert.equal(manifest.slots[3].startMs, 180_000);
    const item = manifest.slots[1].contents[1];
    assert.equal(item.startTimeMs, 10_000);
    assert.equal(item.absoluteStartMs, 70_000);
    assert.equal(item.fit, "held");
    assert.equal(manifest.slots[0].staticImageUrl, "https://cms.example/api/storage/system/still.jpg");
    // what the cab downloads: video + one shared still
    assert.equal(manifest.totalDownloadSizeBytes, 1_000_050);
  });

  it("has a content key that ignores the publish time", () => {
    const first = build(new Date("2026-11-17T00:00:00Z"));
    const again = build(new Date("2026-11-18T00:00:00Z"));
    assert.equal(first.manifestContentKey, again.manifestContentKey);
    assert.notEqual(first.checksum, again.checksum);
    assert.notEqual(build(new Date("2026-11-17T00:00:00Z"), "Renamed").manifestContentKey, first.manifestContentKey);
  });
});

describe("what a publish has to do", () => {
  const current = { compiledContentKey: "c1", compiledVideoKey: "v1", manifestContentKey: "m1", manifestKey: "k1" };
  it("does nothing, rewrites the manifest, or compiles", () => {
    assert.equal(publishWork(current, { compiledContentKey: "c1", manifestContentKey: "m1" }), "nothing");
    assert.equal(publishWork(current, { compiledContentKey: "c1", manifestContentKey: "m2" }), "manifest");
    assert.equal(publishWork(current, { compiledContentKey: "c2", manifestContentKey: "m1" }), "compile");
    assert.equal(publishWork({ ...current, compiledContentKey: null }, { compiledContentKey: "c1", manifestContentKey: "m1" }), "compile");
    assert.equal(publishWork({ ...current, compiledVideoKey: null }, { compiledContentKey: "c1", manifestContentKey: "m1" }), "compile");
  });
});

describe("changes not yet published", () => {
  const draftSlots = standard.map((slot) => ({ ...slot, staticCreativeId: null }));
  const publishedAt = new Date("2026-11-17T00:00:00Z");
  const base = { publishedAt, currentLegacyKey: legacyContentKey(draftSlots), lastSlotEditAt: new Date("2026-11-18T00:00:00Z") };

  it("compares the saved slots with what was published", () => {
    const key = draftKeyOf(draftSlots, frame);
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: key, currentDraftKey: key }), false);
    const edited = draftSlots.map((slot, index) => (index === 0 ? { ...slot, staticCreativeId: "still1" } : slot));
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: key, currentDraftKey: draftKeyOf(edited, frame) }), true);
    assert.notEqual(draftKeyOf(draftSlots, { width: 1920, height: 1080 }), key);
  });

  // A loop published before this release, as the old code left it: slots in the database and an
  // old-format manifest (no formatVersion, slotCount or video block), every new column null.
  const oldManifest = {
    version: "1.0",
    loopId: "l2",
    loopName: "Say Now",
    targetGroupId: null,
    publishedAt: "2026-11-15T07:54:06.115Z",
    totalDurationMs: 600000,
    slots: draftSlots.map((slot) => ({
      position: slot.position,
      staticImageAssetId: null,
      staticImageUrl: "https://cms.example/api/storage/loops/l2/1-static-fallback.jpg",
      staticImageChecksum: "sha256:x",
      advertisementVideoUrl: "https://cms.example/api/storage/assets/ad30/content.mp4",
      contents: slot.contents.map((content) => ({
        type: content.contentType,
        assetId: content.assetId,
        filename: "x.mp4",
        url: "https://cms.example/api/storage/assets/x/content.mp4",
        checksum: "",
        startTimeMs: content.startTimeMs,
        durationMs: content.durationMs,
        fileSizeBytes: 1,
      })),
    })),
    totalDownloadSizeBytes: 1,
    compiledVideoUrl: "https://cms.example/api/storage/loops/l2/v.mp4",
    compiledVideoChecksum: "sha256:v",
    checksum: "sha256:m",
  };

  it("a loop published before this release that nobody edited claims no changes", () => {
    const recorded = legacyContentKeyFromManifest(oldManifest)!;
    assert.equal(recorded, legacyContentKey(draftSlots));
    // Slots saved after the publish time (e.g. rows rewritten by a migration) do not matter.
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: recorded, currentDraftKey: "anything" }), false);
    // Not worked out yet: no claim.
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: null, currentDraftKey: "anything" }), false);
  });

  it("a real edit to such a loop still shows", () => {
    const recorded = legacyContentKeyFromManifest(oldManifest)!;
    const edited = draftSlots.map((slot, index) =>
      index === 3 ? { ...slot, contents: slot.contents.map((content, at) => (at === 1 ? { ...content, assetId: "other" } : content)) } : slot,
    );
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: recorded, currentLegacyKey: legacyContentKey(edited), currentDraftKey: "x" }), true);
  });

  it("an unreadable old manifest only counts edits made after it was looked at", () => {
    assert.equal(legacyContentKeyFromManifest({ nonsense: true }), null);
    const marker = legacyUnknownKey(new Date("2026-11-20T00:00:00Z"));
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: marker, currentDraftKey: "x", lastSlotEditAt: new Date("2026-11-19T00:00:00Z") }), false);
    assert.equal(hasUnpublishedChanges({ ...base, publishedDraftKey: marker, currentDraftKey: "x", lastSlotEditAt: new Date("2026-11-21T00:00:00Z") }), true);
  });

  it("a never-published loop has nothing unpublished", () => {
    assert.equal(hasUnpublishedChanges({ ...base, publishedAt: null, publishedDraftKey: null, currentDraftKey: "x" }), false);
  });
});
