import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPlayback,
  completionPercent,
  summarizePlayback,
  type DailyKindRow,
} from "../src/lib/playback-metrics";

// Rows exactly as firmware 1.0.0/1.1.0 logs them (device/player_manager.py before 1.2.0).
const old = {
  idleStill: { eventName: null, contentType: "ADVERTISEMENT", playbackType: "ADVERTISEMENT", mode: "idle" },
  silentStill: { eventName: null, contentType: "ADVERTISEMENT", playbackType: "ADVERTISEMENT", mode: "silent" },
  journeyAdvert: { eventName: null, contentType: "ADVERTISEMENT", playbackType: "ADVERTISEMENT", mode: "journey" },
  journeyFiller: { eventName: null, contentType: "FILLER", playbackType: "FILLER", mode: "journey" },
  safety: { eventName: null, contentType: null, playbackType: "SAFETY_MESSAGE", mode: "journey" },
  start: { eventName: "JOURNEY_START", contentType: null, playbackType: null, mode: "idle" },
  end: { eventName: "JOURNEY_END", contentType: null, playbackType: null, mode: "journey" },
};

// Rows as firmware 1.2.0 logs them (DEVICE_CONTRACT_V2).
const v12 = {
  still: { eventName: null, contentType: null, playbackType: "STATIC_IMAGE", mode: "idle" },
  continuousAdvert: { eventName: null, contentType: "ADVERTISEMENT", playbackType: "ADVERTISEMENT", mode: "continuous" },
  continuousStill: { eventName: null, contentType: null, playbackType: "STATIC_IMAGE", mode: "continuous" },
  safety: { eventName: null, contentType: null, playbackType: "SAFETY", mode: "journey" },
};

describe("classifyPlayback", () => {
  it("does not count old firmware's idle and muted stills as advert plays", () => {
    assert.equal(classifyPlayback(old.idleStill), "still");
    assert.equal(classifyPlayback(old.silentStill), "still");
  });

  it("counts video adverts played in a journey", () => {
    assert.equal(classifyPlayback(old.journeyAdvert), "advert");
    assert.equal(classifyPlayback(old.journeyFiller), "filler");
  });

  it("keeps safety messages and journey markers out of plays", () => {
    assert.equal(classifyPlayback(old.safety), "safety");
    assert.equal(classifyPlayback(old.start), "journey_start");
    assert.equal(classifyPlayback(old.end), "journey_end");
    assert.equal(classifyPlayback(v12.safety), "safety");
  });

  it("understands firmware 1.2.0 stills and continuous mode", () => {
    assert.equal(classifyPlayback(v12.still), "still");
    assert.equal(classifyPlayback(v12.continuousStill), "still");
    assert.equal(classifyPlayback(v12.continuousAdvert), "advert");
  });

  it("counts a directly uploaded loop's full pass as a loop pass, not an advert", () => {
    assert.equal(classifyPlayback({ eventName: null, contentType: null, playbackType: "LOOP_VIDEO", mode: "continuous" }), "loop_pass");
    assert.equal(classifyPlayback({ eventName: null, contentType: null, playbackType: "LOOP_VIDEO", mode: "journey" }), "loop_pass");
  });

  it("puts anything unrecognised in 'other'", () => {
    assert.equal(classifyPlayback({ eventName: null, contentType: "ADVERTISEMENT", playbackType: null, mode: null }), "other");
    assert.equal(classifyPlayback({ eventName: "SOMETHING", contentType: "ADVERTISEMENT", playbackType: null, mode: "journey" }), "other");
  });
});

const row = (day: string, kind: DailyKindRow["kind"], plays: number, extra: Partial<DailyKindRow> = {}): DailyKindRow => ({
  day,
  kind,
  plays,
  measured: 0,
  measuredCompleted: 0,
  durationMsSum: 0,
  journeyModePlays: 0,
  ...extra,
});

describe("summarizePlayback", () => {
  const periods = {
    todayKey: "2026-11-17",
    weekStartKey: "2026-11-16",
    monthStartKey: "2026-11-01",
    seriesKeys: ["2026-11-15", "2026-11-16", "2026-11-17"],
  };

  it("separates advert plays from still showings and counts journeys by London period", () => {
    const summary = summarizePlayback(
      [
        row("2026-11-17", "advert", 10, { journeyModePlays: 10 }),
        row("2026-11-17", "still", 300),
        row("2026-11-16", "advert", 4, { journeyModePlays: 4 }),
        row("2026-11-17", "journey_start", 2),
        row("2026-11-15", "journey_start", 1),
        row("2026-11-02", "journey_start", 5), // this month, before the chart
        row("2026-11-17", "journey_end", 2, { durationMsSum: 1_200_000 }),
      ],
      periods,
    );
    assert.equal(summary.totals.advertPlays, 14);
    assert.equal(summary.totals.advertPlaysToday, 10);
    assert.equal(summary.totals.stillShowings, 300);
    assert.deepEqual(summary.journeys, {
      today: 2,
      week: 2,
      month: 8,
      averageDurationMs: 600_000,
      advertPlaysPerJourney: Number((14 / 3).toFixed(1)),
    });
    assert.deepEqual(
      summary.series.map((point) => point.advertPlays),
      [0, 4, 10],
    );
    assert.deepEqual(summary.busiestDay, { day: "2026-11-17", advertPlays: 10 });
  });

  it("reports completion as not measured when no row carries measured data (old firmware)", () => {
    const summary = summarizePlayback([row("2026-11-17", "advert", 50)], periods);
    assert.equal(summary.completion.ratePercent, null);
    assert.equal(completionPercent(0, 0), null);
  });

  it("computes completion only from measured rows", () => {
    const summary = summarizePlayback(
      [row("2026-11-17", "advert", 60, { measured: 20, measuredCompleted: 15 })],
      periods,
    );
    assert.deepEqual(summary.completion, { measuredPlays: 20, completedPlays: 15, ratePercent: 75 });
  });

  it("does not divide by zero journeys", () => {
    const summary = summarizePlayback([row("2026-11-17", "advert", 6, { journeyModePlays: 0 })], periods);
    assert.equal(summary.journeys.advertPlaysPerJourney, null);
    assert.equal(summary.journeys.averageDurationMs, null);
  });
});
