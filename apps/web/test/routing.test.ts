import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRoutingSnapshot, resolveDeviceLoop, resolveGroupLevel, type RoutableLoop } from "../src/lib/routing-core";

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
    checksum: `sum-${id}`,
    publishedAt: t(0),
    ...overrides,
  };
}

function snap(input: {
  loops: RoutableLoop[];
  groups?: Array<{ id: string; assignedLoopId: string | null; assignmentAt: Date | null }>;
  fleet?: { loopId: string; at: Date } | null;
}) {
  return buildRoutingSnapshot({
    loops: input.loops,
    groups: input.groups ?? [{ id: "g1", assignedLoopId: null, assignmentAt: null }],
    fleetAssignment: input.fleet ? { loopId: input.fleet.loopId, assignedAt: input.fleet.at, assignedBy: null } : null,
  });
}

describe("resolveDeviceLoop", () => {
  it("returns null when nothing is published", () => {
    assert.deepEqual(resolveDeviceLoop({ groupId: "g1" }, snap({ loops: [] })), { loop: null, source: null });
  });

  it("legacy: latest fleet-wide autoLive publish", () => {
    const s = snap({ loops: [loop("old", { publishedAt: t(1) }), loop("new", { publishedAt: t(2) })] });
    const r = resolveDeviceLoop({ groupId: null }, s);
    assert.equal(r.loop?.id, "new");
    assert.equal(r.source, "fleet");
  });

  it("legacy: group publish beats fleet for members only", () => {
    const s = snap({
      loops: [loop("fleet", { publishedAt: t(5) }), loop("grp", { targetGroupId: "g1", publishedAt: t(1) })],
    });
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, s).loop?.id, "grp");
    assert.equal(resolveDeviceLoop({ groupId: "g2" }, s).loop?.id, "fleet");
  });

  it("autoLive=false (phone upload) never goes live by publishing", () => {
    const s = snap({ loops: [loop("fleet", { publishedAt: t(1) }), loop("phone", { autoLive: false, publishedAt: t(9) })] });
    assert.equal(resolveDeviceLoop({ groupId: null }, s).loop?.id, "fleet");
  });

  it("cab override beats group beats fleet", () => {
    const loops = [loop("fleet", { publishedAt: t(1) }), loop("grp", { autoLive: false }), loop("cab", { autoLive: false })];
    const groups = [{ id: "g1", assignedLoopId: "grp", assignmentAt: t(2) }];
    const s = snap({ loops, groups });
    assert.deepEqual(
      [resolveDeviceLoop({ groupId: "g1", overrideLoopId: "cab" }, s).source, resolveDeviceLoop({ groupId: "g1", overrideLoopId: "cab" }, s).loop?.id],
      ["cab", "cab"],
    );
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, s).loop?.id, "grp");
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, s).source, "group");
    assert.equal(resolveDeviceLoop({ groupId: null }, s).loop?.id, "fleet");
  });

  it("newer desktop group publish beats older explicit group assignment, and vice versa", () => {
    const groupsOld = [{ id: "g1", assignedLoopId: "assigned", assignmentAt: t(1) }];
    const loops = [loop("assigned", { autoLive: false }), loop("desk", { targetGroupId: "g1", publishedAt: t(2) })];
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, snap({ loops, groups: groupsOld })).loop?.id, "desk");
    const groupsNew = [{ id: "g1", assignedLoopId: "assigned", assignmentAt: t(3) }];
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, snap({ loops, groups: groupsNew })).loop?.id, "assigned");
  });

  it("fleet: explicit vs legacy, newer wins", () => {
    const loops = [loop("legacy", { publishedAt: t(5) }), loop("explicit", { autoLive: false })];
    assert.equal(resolveDeviceLoop({}, snap({ loops, fleet: { loopId: "explicit", at: t(4) } })).loop?.id, "legacy");
    assert.equal(resolveDeviceLoop({}, snap({ loops, fleet: { loopId: "explicit", at: t(6) } })).loop?.id, "explicit");
  });

  it("follow fleet: newer null group assignment beats legacy group publish", () => {
    const loops = [loop("fleet", { publishedAt: t(0) }), loop("grp", { targetGroupId: "g1", publishedAt: t(1) })];
    const groups = [{ id: "g1", assignedLoopId: null, assignmentAt: t(2) }];
    const s = snap({ loops, groups });
    const r = resolveDeviceLoop({ groupId: "g1" }, s);
    assert.equal(r.loop?.id, "fleet");
    assert.equal(r.source, "fleet");
    assert.equal(resolveGroupLevel("g1", s).explicitFollowFleet, true);
    // ...but an even newer desktop publish to the group wins again.
    const s2 = snap({ loops: [...loops, loop("grp2", { targetGroupId: "g1", publishedAt: t(3) })], groups });
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, s2).loop?.id, "grp2");
  });

  it("unservable winners fall through", () => {
    // Override to an unpublished loop is ignored.
    const s = snap({
      loops: [loop("fleet"), loop("draft", { status: "DRAFT" }), loop("nomanifest", { manifestUrl: null, autoLive: false })],
      groups: [{ id: "g1", assignedLoopId: "nomanifest", assignmentAt: t(5) }],
    });
    const r = resolveDeviceLoop({ groupId: "g1", overrideLoopId: "draft" }, s);
    assert.equal(r.loop?.id, "fleet");
    assert.equal(r.source, "fleet");
  });

  it("unservable group assignment falls back to the older legacy group loop", () => {
    const s = snap({
      loops: [loop("fleet"), loop("grp", { targetGroupId: "g1", publishedAt: t(1) })],
      groups: [{ id: "g1", assignedLoopId: "archived-loop", assignmentAt: t(5) }],
    });
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, s).loop?.id, "grp");
  });

  it("unservable fleet assignment falls back to legacy fleet loop", () => {
    const s = snap({ loops: [loop("legacy", { publishedAt: t(1) })], fleet: { loopId: "gone", at: t(9) } });
    assert.equal(resolveDeviceLoop({}, s).loop?.id, "legacy");
  });

  it("clearing an override returns the cab to its group", () => {
    const s = snap({ loops: [loop("grp", { targetGroupId: "g1" }), loop("cab", { autoLive: false })] });
    assert.equal(resolveDeviceLoop({ groupId: "g1", overrideLoopId: "cab" }, s).loop?.id, "cab");
    assert.equal(resolveDeviceLoop({ groupId: "g1", overrideLoopId: null }, s).loop?.id, "grp");
  });
});
