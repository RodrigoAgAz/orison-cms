import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRoutingSnapshot, type RoutableLoop } from "../src/lib/routing-core";
import {
  afterConditionalPublish,
  isProcessingStale,
  shouldApplyUploadTarget,
  STALE_PUBLISHING_MS,
  staleTargetMessage,
  targetLastChangedAt,
  UPLOAD_LIVENESS_INTERVAL_MS,
} from "../src/lib/upload-rules";

const t = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 10, minutes));

function loop(id: string, overrides: Partial<RoutableLoop> = {}): RoutableLoop {
  return {
    id,
    name: id,
    status: "PUBLISHED",
    targetGroupId: null,
    autoLive: true,
    manifestUrl: `http://x/${id}.json`,
    compiledVideoUrl: null,
    version: 1,
    checksum: null,
    publishedAt: t(0),
    ...overrides,
  };
}

describe("afterConditionalPublish", () => {
  it("discards a publish the database refused (removed or failed meanwhile): no target is applied", () => {
    assert.equal(afterConditionalPublish({ publishedRows: 0, hasPendingTarget: true }), "discard");
    assert.equal(afterConditionalPublish({ publishedRows: 0, hasPendingTarget: false }), "discard");
  });
  it("applies the target only after a successful publish", () => {
    assert.equal(afterConditionalPublish({ publishedRows: 1, hasPendingTarget: true }), "apply-target");
    assert.equal(afterConditionalPublish({ publishedRows: 1, hasPendingTarget: false }), "done");
  });
});

describe("processing liveness", () => {
  it("allows several missed liveness ticks before a job counts as dead", () => {
    assert.ok(STALE_PUBLISHING_MS >= 5 * UPLOAD_LIVENESS_INTERVAL_MS);
    const now = t(30);
    assert.equal(isProcessingStale(new Date(now.getTime() - UPLOAD_LIVENESS_INTERVAL_MS * 2), now), false);
    assert.equal(isProcessingStale(new Date(now.getTime() - STALE_PUBLISHING_MS - 1), now), true);
  });
});

describe("stale upload target", () => {
  const requestedAt = t(10);
  const groups = [
    { id: "g1", assignedLoopId: "a", assignmentAt: t(5) },
    { id: "g2", assignedLoopId: null, assignmentAt: t(12) },
    { id: "g3", assignedLoopId: null, assignmentAt: null },
  ];

  it("fleet: an explicit change after the upload was requested wins", () => {
    const snapshot = buildRoutingSnapshot({
      loops: [loop("a")],
      groups,
      fleetAssignment: { loopId: "a", assignedAt: t(11), assignedBy: null },
    });
    const changed = targetLastChangedAt({ type: "fleet" }, snapshot);
    assert.deepEqual(changed, t(11));
    assert.equal(shouldApplyUploadTarget(changed, requestedAt), false);
  });

  it("fleet: a desktop publish after the request also counts as a change", () => {
    const snapshot = buildRoutingSnapshot({
      loops: [loop("desk", { publishedAt: t(15) })],
      groups,
      fleetAssignment: { loopId: "a", assignedAt: t(1), assignedBy: null },
    });
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt({ type: "fleet" }, snapshot), requestedAt), false);
  });

  it("fleet: older changes do not block the upload", () => {
    const snapshot = buildRoutingSnapshot({
      loops: [loop("a", { publishedAt: t(2) })],
      groups,
      fleetAssignment: { loopId: "a", assignedAt: t(3), assignedBy: null },
    });
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt({ type: "fleet" }, snapshot), requestedAt), true);
  });

  it("group: assignment (including 'follow all cabs') and legacy group publishes", () => {
    const snapshot = buildRoutingSnapshot({
      loops: [loop("g3loop", { targetGroupId: "g3", publishedAt: t(20) })],
      groups,
      fleetAssignment: null,
    });
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt({ type: "group", groupId: "g1" }, snapshot), requestedAt), true);
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt({ type: "group", groupId: "g2" }, snapshot), requestedAt), false);
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt({ type: "group", groupId: "g3" }, snapshot), requestedAt), false);
    // A change to the fleet does not block a group target.
    assert.equal(targetLastChangedAt({ type: "group", groupId: "unknown" }, snapshot), null);
  });

  it("cab: its own override set or cleared after the request wins", () => {
    const snapshot = buildRoutingSnapshot({ loops: [], groups, fleetAssignment: null });
    const target = { type: "cab" as const, deviceId: "d1" };
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt(target, snapshot, { overrideAt: t(11) }), requestedAt), false);
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt(target, snapshot, { overrideAt: t(9) }), requestedAt), true);
    assert.equal(shouldApplyUploadTarget(targetLastChangedAt(target, snapshot, { overrideAt: null }), requestedAt), true);
  });

  it("a change at exactly the request time does not block it", () => {
    assert.equal(shouldApplyUploadTarget(requestedAt, requestedAt), true);
  });

  it("explains the skip in plain words", () => {
    assert.match(staleTargetMessage("all cabs"), /^It wasn't put on all cabs, because what all cabs play was changed while this video was uploading/);
    assert.match(staleTargetMessage("group City"), /what group City plays was changed/);
  });
});
