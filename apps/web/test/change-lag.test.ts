import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changeLagMinutesFor, parseFirmwareVersion, reactsToHeartbeat, summarizeChangeLag } from "../src/lib/change-lag";

const settings = { heartbeatIntervalSeconds: 300, syncIntervalSeconds: 1800 };

describe("reactsToHeartbeat", () => {
  it("is true from firmware 1.1.0", () => {
    for (const version of ["1.1.0", "1.1", "1.1.3", "1.2.0", "2.0.0", "v1.1.0", "1.10.0"]) {
      assert.equal(reactsToHeartbeat(version), true, version);
    }
  });
  it("is false for older or unknown firmware", () => {
    for (const version of ["1.0.0", "1.0.9", "0.9.0", "1", null, undefined, "", "unknown"]) {
      assert.equal(reactsToHeartbeat(version), false, String(version));
    }
  });
  it("parses versions", () => {
    assert.deepEqual(parseFirmwareVersion("1.1.0"), [1, 1, 0]);
    assert.deepEqual(parseFirmwareVersion("2"), [2, 0, 0]);
    assert.equal(parseFirmwareVersion("abc"), null);
  });
});

describe("changeLagMinutesFor", () => {
  it("new firmware: one heartbeat interval", () => {
    assert.equal(changeLagMinutesFor("1.1.0", settings), 5);
    assert.equal(changeLagMinutesFor("1.1.0", { heartbeatIntervalSeconds: 90, syncIntervalSeconds: 1800 }), 2);
  });
  it("old firmware: the sync interval (30 minutes in the field)", () => {
    assert.equal(changeLagMinutesFor("1.0.0", settings), 30);
    assert.equal(changeLagMinutesFor(null, settings), 30);
  });
  it("old firmware never reports less than the heartbeat interval", () => {
    assert.equal(changeLagMinutesFor("1.0.0", { heartbeatIntervalSeconds: 600, syncIntervalSeconds: 300 }), 10);
  });
});

describe("summarizeChangeLag", () => {
  it("gives the honest worst case for a mixed fleet", () => {
    assert.deepEqual(summarizeChangeLag([5, 30, 5], settings), { minMinutes: 5, maxMinutes: 30, slowCabs: 1 });
  });
  it("all new firmware", () => {
    assert.deepEqual(summarizeChangeLag([5, 5], settings), { minMinutes: 5, maxMinutes: 5, slowCabs: 0 });
  });
  it("no cabs: assume old firmware", () => {
    assert.deepEqual(summarizeChangeLag([], settings), { minMinutes: 30, maxMinutes: 30, slowCabs: 0 });
  });
});
