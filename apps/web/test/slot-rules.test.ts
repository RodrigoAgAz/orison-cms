import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultAdvertDurationMs,
  describeArithmetic,
  draftSlotProblems,
  fillerTemplateProblems,
  fitOf,
  fitTemplateDurations,
  fitWarning,
  publishSlotProblems,
  slotArithmetic,
  withSequentialStartTimes,
  type RuleContent,
} from "../src/lib/slot-rules";

const video = (durationMs: number | null) => ({ id: "a", filename: "ad.mp4", mimeType: "video/mp4", durationMs });
const still = { id: "s", filename: "still.jpg", mimeType: "image/jpeg", durationMs: null };

function slot(...items: Array<[RuleContent["contentType"], number]>): RuleContent[] {
  let at = 0;
  return items.map(([contentType, durationMs], orderInSlot) => {
    const content = { assetId: `a${orderInSlot}`, orderInSlot, startTimeMs: at, durationMs, contentType };
    at += durationMs;
    return content;
  });
}

describe("advert length", () => {
  it("takes the length of its file, rounded to 0.1 s, within 1..60 s", () => {
    assert.equal(defaultAdvertDurationMs(video(30_016)), 30_000);
    assert.equal(defaultAdvertDurationMs(video(9_960)), 10_000);
    assert.equal(defaultAdvertDurationMs(video(12_012)), 12_000);
    assert.equal(defaultAdvertDurationMs(video(400)), 1_000);
    assert.equal(defaultAdvertDurationMs(video(95_000)), 60_000);
    assert.equal(defaultAdvertDurationMs(still), 10_000);
    assert.equal(defaultAdvertDurationMs(video(null)), 10_000);
  });
});

describe("fit of a file to its time", () => {
  it("is exact within one frame, cut when longer, held when shorter", () => {
    assert.deepEqual(fitOf(video(12_010), 12_000), { kind: "exact" });
    assert.deepEqual(fitOf(video(30_000), 12_000), { kind: "cut", byMs: 18_000 });
    assert.deepEqual(fitOf(video(1_500), 15_000), { kind: "held", byMs: 13_500 });
    assert.deepEqual(fitOf(still, 15_000), { kind: "still" });
    assert.deepEqual(fitOf(null, 15_000), { kind: "unknown" });
  });
  it("says what will happen in plain words", () => {
    assert.match(fitWarning({ contentType: "ADVERTISEMENT", durationMs: 12_000, asset: video(30_000) })!, /last 18 s will be cut off/);
    assert.match(fitWarning({ contentType: "FILLER", durationMs: 15_000, asset: video(1_500) })!, /last frame will be held, silent, for 13.5 s/);
    assert.equal(fitWarning({ contentType: "FILLER", durationMs: 15_000, asset: still }), null);
  });
});

describe("slot arithmetic", () => {
  it("adds up and says how far from a minute", () => {
    const arithmetic = slotArithmetic(slot(["ADVERTISEMENT", 30_000], ["FILLER", 10_000], ["FILLER", 15_000]));
    assert.equal(arithmetic.totalMs, 55_000);
    assert.equal(arithmetic.remainingMs, 5_000);
    assert.equal(describeArithmetic(arithmetic), "advert 30 s + fillers 10 s + 15 s = 55 s, 5 s short of 60 s");
    assert.equal(
      describeArithmetic(slotArithmetic(slot(["ADVERTISEMENT", 12_000], ["FILLER", 48_000]))),
      "advert 12 s + filler 48 s = 60 s, exactly 60 s",
    );
  });

  it("lays items end to end", () => {
    const laid = withSequentialStartTimes([
      { orderInSlot: 1, durationMs: 20_000, startTimeMs: 999 },
      { orderInSlot: 0, durationMs: 10_000, startTimeMs: 5 },
    ]);
    assert.deepEqual(laid.map((item) => [item.orderInSlot, item.startTimeMs]), [[0, 0], [1, 10_000]]);
  });
});

describe("slot validation", () => {
  it("keeps a legacy slot (12 s advert, 48 s of fillers) valid", () => {
    assert.deepEqual(publishSlotProblems(slot(["ADVERTISEMENT", 12_000], ["FILLER", 18_000], ["FILLER", 15_000], ["FILLER", 15_000])), []);
  });
  it("accepts adverts of any length that add up to a minute", () => {
    assert.deepEqual(publishSlotProblems(slot(["ADVERTISEMENT", 30_000], ["FILLER", 30_000])), []);
    assert.deepEqual(publishSlotProblems(slot(["ADVERTISEMENT", 10_000], ["FILLER", 50_000])), []);
  });
  it("lets a draft be incomplete but not nonsensical", () => {
    assert.deepEqual(draftSlotProblems(slot(["ADVERTISEMENT", 30_000])), []);
    assert.match(draftSlotProblems(slot(["ADVERTISEMENT", 30_000], ["ADVERTISEMENT", 10_000]))[0], /only one advert/);
    assert.match(draftSlotProblems(slot(["ADVERTISEMENT", 50_000], ["FILLER", 15_000]))[0], /more than 60 s/);
    assert.match(draftSlotProblems(slot(["ADVERTISEMENT", 500]))[0], /at least 1 s/);
    const overlapping = slot(["ADVERTISEMENT", 20_000], ["FILLER", 20_000]);
    overlapping[1].startTimeMs = 10_000;
    assert.match(draftSlotProblems(overlapping)[0], /overlap/);
  });
  it("refuses to publish a slot that is short, has no advert or has a gap", () => {
    assert.match(publishSlotProblems(slot(["ADVERTISEMENT", 30_000], ["FILLER", 25_000]))[0], /5 s short of 60 s/);
    assert.match(publishSlotProblems(slot(["FILLER", 60_000]))[0], /Choose an advert/);
    const gap = slot(["ADVERTISEMENT", 30_000], ["FILLER", 30_000]);
    gap[0].startTimeMs = 0;
    gap[1].startTimeMs = 30_000;
    gap[0].durationMs = 25_000;
    gap[1].durationMs = 35_000;
    gap[1].startTimeMs = 25_500;
    assert.ok(publishSlotProblems(gap).length > 0);
  });
});

describe("filler template", () => {
  it("adjusts the last row to fill the time the advert leaves", () => {
    assert.deepEqual(fitTemplateDurations([{ category: "ANY_FILLER", durationMs: 48_000 }], 30_000), {
      ok: true,
      durations: [30_000],
      adjustedLastByMs: -18_000,
    });
    assert.deepEqual(
      fitTemplateDurations(
        [
          { category: "FILLER_BRANDED", durationMs: 20_000 },
          { category: "FILLER_OTHER", durationMs: 28_000 },
        ],
        50_000,
      ),
      { ok: true, durations: [20_000, 30_000], adjustedLastByMs: 2_000 },
    );
  });
  it("says why it cannot fit", () => {
    const result = fitTemplateDurations(
      [
        { category: "FILLER_BRANDED", durationMs: 40_000 },
        { category: "FILLER_OTHER", durationMs: 8_000 },
      ],
      30_000,
    );
    assert.equal(result.ok, false);
    assert.equal(fitTemplateDurations([], 30_000).ok, false);
  });
  it("allows an empty template and refuses one with no room for an advert", () => {
    assert.deepEqual(fillerTemplateProblems([]), []);
    assert.match(fillerTemplateProblems([{ category: "ANY_FILLER", durationMs: 60_000 }])[0], /no room for an advert/);
    assert.match(fillerTemplateProblems([{ category: "ANY_FILLER", durationMs: 500 }])[0], /at least 1 s/);
  });
});
