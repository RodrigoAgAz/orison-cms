import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addDaysToKey,
  dayKeysBetween,
  formatLondonDateTime,
  isDayKey,
  londonDayKey,
  londonDayRange,
  londonDayStart,
  londonPeriods,
  weekStartKey,
} from "../src/lib/london-time";

const hours = (range: { start: Date; end: Date }) => (range.end.getTime() - range.start.getTime()) / 3_600_000;

describe("London calendar days", () => {
  it("starts a winter day at 00:00 UTC and a summer day at 23:00 UTC the day before", () => {
    assert.equal(londonDayStart("2026-01-15").toISOString(), "2026-01-15T00:00:00.000Z");
    assert.equal(londonDayStart("2026-07-02").toISOString(), "2026-07-01T23:00:00.000Z");
  });

  it("puts 00:30 BST in the London day, not the UTC one", () => {
    // The audit's case: a play at 00:30 on 2 July in London is 23:30 UTC on 1 July.
    assert.equal(londonDayKey(new Date("2026-07-01T23:30:00Z")), "2026-07-02");
    assert.equal(londonDayKey(new Date("2026-07-01T22:59:59Z")), "2026-07-01");
    assert.equal(londonDayKey(new Date("2026-01-15T23:30:00Z")), "2026-01-15");
  });

  it("handles the spring clock change (23-hour day)", () => {
    const range = londonDayRange("2026-03-29");
    assert.equal(range.start.toISOString(), "2026-03-29T00:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-03-29T23:00:00.000Z");
    assert.equal(hours(range), 23);
    // 00:59 UTC is still GMT; 01:00 UTC is 02:00 BST, same day.
    assert.equal(londonDayKey(new Date("2026-03-29T00:59:00Z")), "2026-03-29");
    assert.equal(londonDayKey(new Date("2026-03-29T22:59:00Z")), "2026-03-29");
    assert.equal(londonDayKey(new Date("2026-03-29T23:00:00Z")), "2026-03-30");
  });

  it("handles the autumn clock change (25-hour day)", () => {
    const range = londonDayRange("2026-10-25");
    assert.equal(range.start.toISOString(), "2026-10-24T23:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-10-26T00:00:00.000Z");
    assert.equal(hours(range), 25);
    assert.equal(londonDayKey(new Date("2026-10-24T23:00:00Z")), "2026-10-25");
    assert.equal(londonDayKey(new Date("2026-10-25T23:59:00Z")), "2026-10-25");
  });

  it("gives consecutive ranges with no gap or overlap across both changes", () => {
    const keys = dayKeysBetween("2026-03-27", "2026-03-31").concat(dayKeysBetween("2026-10-23", "2026-10-27"));
    for (const key of keys) {
      assert.equal(londonDayRange(key).end.getTime(), londonDayStart(addDaysToKey(key, 1)).getTime(), key);
    }
  });

  it("weeks start on Monday and months on the 1st, in London", () => {
    assert.equal(weekStartKey("2026-11-17"), "2026-11-16"); // Tuesday -> Monday
    assert.equal(weekStartKey("2026-11-16"), "2026-11-16");
    assert.equal(weekStartKey("2026-11-22"), "2026-11-16"); // Sunday
    // Sunday 23:30 UTC in summer is already Monday in London.
    const periods = londonPeriods(new Date("2026-07-05T23:30:00Z"));
    assert.equal(periods.todayKey, "2026-07-06");
    assert.equal(periods.weekStartKey, "2026-07-06");
    assert.equal(periods.weekStart.toISOString(), "2026-07-05T23:00:00.000Z");
    assert.equal(periods.monthStart.toISOString(), "2026-06-30T23:00:00.000Z");
  });

  it("validates calendar dates", () => {
    assert.ok(isDayKey("2026-02-28"));
    assert.ok(!isDayKey("2026-02-30"));
    assert.ok(!isDayKey("2026-2-3"));
    assert.ok(!isDayKey(null));
  });

  it("formats in en-GB London time", () => {
    assert.equal(formatLondonDateTime(new Date("2026-07-01T23:30:00Z")), "2 Jul 2026, 00:30");
    assert.equal(formatLondonDateTime(null), "Never");
  });
});
