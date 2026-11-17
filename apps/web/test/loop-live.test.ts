import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeEffect, effectToken, pauseEffect, snapshotOf, targetChangeEffect, type RoutingWorld, type WorldLoop } from "../src/lib/loop-live";
import { clampPage } from "../src/lib/loop-queries";
import { copyName } from "../src/lib/loops";

const loop = (id: string, publishedAt: string, targetGroupId: string | null = null): WorldLoop => ({
  id,
  name: id,
  status: "PUBLISHED",
  targetGroupId,
  autoLive: true,
  manifestUrl: `https://x/${id}.json`,
  compiledVideoUrl: null,
  compiledVideoKey: null,
  posterKey: null,
  version: 1,
  checksum: "c",
  publishedAt: new Date(publishedAt),
  updatedAt: new Date(publishedAt),
});

const world: RoutingWorld = {
  loops: [loop("old", "2026-11-01T00:00:00Z"), loop("new", "2026-11-10T00:00:00Z"), loop("grouped", "2026-11-05T00:00:00Z", "g1")],
  groups: [
    { id: "g1", name: "TCR", assignedLoopId: null, assignmentAt: null },
    { id: "g2", name: "West", assignedLoopId: null, assignmentAt: null },
  ],
  fleetAssignment: null,
  devices: [
    { id: "d1", serialNumber: "S1", cabLicenseNumber: "LR68", groupId: null, overrideLoopId: null },
    { id: "d2", serialNumber: "S2", cabLicenseNumber: null, groupId: "g1", overrideLoopId: null },
    { id: "d3", serialNumber: "S3", cabLicenseNumber: null, groupId: "g2", overrideLoopId: null },
  ],
};

describe("what a change does to cabs", () => {
  it("pausing the fleet loop names what plays instead", () => {
    const effect = pauseEffect(world, "new");
    assert.deepEqual(effect.levels.find((level) => level.label === "All cabs"), { label: "All cabs", from: { id: "new", name: "new" }, to: { id: "old", name: "old" } });
    assert.deepEqual(effect.cabs, [{ from: { id: "new", name: "new" }, to: { id: "old", name: "old" }, count: 2, examples: ["LR68", "S3"] }]);
  });

  it("moving a live loop to another group changes both scopes", () => {
    const effect = targetChangeEffect(world, "grouped", "g2", new Date("2026-11-17T00:00:00Z"));
    const labels = effect.levels.map((level) => `${level.label}:${level.from?.id}>${level.to?.id}`);
    assert.deepEqual(labels.sort(), ["Group TCR:grouped>new", "Group West:new>grouped"]);
    assert.equal(effect.cabs.reduce((sum, bucket) => sum + bucket.count, 0), 2);
  });

  it("no change, no lines; the token follows the effect", () => {
    const snapshot = snapshotOf(world);
    const none = describeEffect(world, snapshot, snapshot);
    assert.equal(none.changes, false);
    assert.notEqual(effectToken(pauseEffect(world, "new")), effectToken(none));
    assert.equal(effectToken(pauseEffect(world, "new")), effectToken(pauseEffect(world, "new")));
  });
});

describe("small list helpers", () => {
  it("a page past the end shows the last page", () => {
    assert.deepEqual(clampPage(99, 12, 25), { page: 3, pageCount: 3 });
    assert.deepEqual(clampPage(1, 12, 0), { page: 1, pageCount: 1 });
  });
  it("copies get a name no other loop has", () => {
    assert.equal(copyName("DAZN rotation", new Set()), "DAZN rotation (copy)");
    assert.equal(copyName("DAZN rotation (copy)", new Set(["DAZN rotation (copy)"])), "DAZN rotation (copy 2)");
  });
});
