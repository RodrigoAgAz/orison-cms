import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  coveredSeconds,
  heartbeatIntervals,
  offlineThresholdMs,
  resolveDesktopDeviceStatus,
  resolveMobileDeviceStatus,
  startOfLocalDay,
} from "../src/lib/device-status";

const now = new Date("2026-11-15T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const base = { isActive: true, isDisabled: false, currentLoopId: "a" };

describe("offline threshold", () => {
  it("is max(3 x interval, 10 minutes)", () => {
    assert.equal(offlineThresholdMs(300), 15 * 60_000);
    assert.equal(offlineThresholdMs(60), 10 * 60_000);
    assert.equal(offlineThresholdMs(1800), 90 * 60_000);
    assert.equal(offlineThresholdMs(undefined), 15 * 60_000);
  });
});

describe("device status", () => {
  const threshold = offlineThresholdMs(300);
  it("desktop labels", () => {
    assert.equal(resolveDesktopDeviceStatus({ ...base, isActive: false, lastHeartbeatAt: ago(1) }, "a", threshold, now), "inactive");
    assert.equal(resolveDesktopDeviceStatus({ ...base, lastHeartbeatAt: null }, "a", threshold, now), "offline");
    assert.equal(resolveDesktopDeviceStatus({ ...base, lastHeartbeatAt: ago(16) }, "a", threshold, now), "offline");
    assert.equal(resolveDesktopDeviceStatus({ ...base, lastHeartbeatAt: ago(14) }, "a", threshold, now), "online");
    assert.equal(resolveDesktopDeviceStatus({ ...base, lastHeartbeatAt: ago(1) }, "b", threshold, now), "outdated");
    assert.equal(resolveDesktopDeviceStatus({ ...base, lastHeartbeatAt: ago(1) }, null, threshold, now), "online");
  });
  it("mobile labels add paused and rename outdated", () => {
    const opts = { thresholdMs: threshold, fleetDisabled: false, now };
    assert.equal(resolveMobileDeviceStatus({ ...base, lastHeartbeatAt: ago(1) }, "b", opts), "updating");
    assert.equal(resolveMobileDeviceStatus({ ...base, isDisabled: true, lastHeartbeatAt: ago(1) }, "a", opts), "paused");
    assert.equal(resolveMobileDeviceStatus({ ...base, lastHeartbeatAt: ago(60) }, "a", { ...opts, fleetDisabled: true }), "paused");
    assert.equal(resolveMobileDeviceStatus({ ...base, isActive: false, isDisabled: true, lastHeartbeatAt: null }, "a", opts), "inactive");
    assert.equal(resolveMobileDeviceStatus({ ...base, lastHeartbeatAt: ago(60) }, "a", opts), "offline");
  });
});

describe("heartbeat intervals", () => {
  it("splits on gaps, keeps a live run open to now and adds a tail to closed runs", () => {
    const beats = [ago(120), ago(115), ago(110), /* gap */ ago(30), ago(25), ago(20), ago(15), ago(10), ago(5)];
    const intervals = heartbeatIntervals(beats, 15 * 60_000, now, 5 * 60_000);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0].start.toISOString(), ago(120).toISOString());
    assert.equal(intervals[0].end.toISOString(), ago(105).toISOString());
    assert.equal(intervals[1].start.toISOString(), ago(30).toISOString());
    assert.equal(intervals[1].end.toISOString(), now.toISOString());
    assert.equal(coveredSeconds(intervals, ago(60), now), 30 * 60);
  });
  it("empty input", () => {
    assert.deepEqual(heartbeatIntervals([], 1000, now), []);
  });
});

describe("startOfLocalDay (Europe/London)", () => {
  it("GMT in winter", () => {
    assert.equal(startOfLocalDay(new Date("2026-11-15T12:00:00Z")).toISOString(), "2026-11-15T00:00:00.000Z");
  });
  it("BST in summer", () => {
    assert.equal(startOfLocalDay(new Date("2026-07-01T12:00:00Z")).toISOString(), "2026-06-30T23:00:00.000Z");
    assert.equal(startOfLocalDay(new Date("2026-07-01T23:30:00Z")).toISOString(), "2026-07-01T23:00:00.000Z");
  });
  it("DST change days", () => {
    // Clocks go forward 2026-03-29 01:00 UTC; midnight that day is still GMT.
    assert.equal(startOfLocalDay(new Date("2026-03-29T12:00:00Z")).toISOString(), "2026-03-29T00:00:00.000Z");
    // Clocks go back 2026-10-25 01:00 UTC; midnight that day was BST.
    assert.equal(startOfLocalDay(new Date("2026-10-25T12:00:00Z")).toISOString(), "2026-10-24T23:00:00.000Z");
  });
});
