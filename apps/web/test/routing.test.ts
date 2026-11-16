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

// ---------------------------------------------------------------------------------------------
// Deploy safety: on data that predates explicit assignments, every cab must be served exactly
// what the previous resolver served it, including the cases where it was served nothing.
// ---------------------------------------------------------------------------------------------

/** The resolver as it was before this feature (lib/loop-routing.ts + the manifest route on main). */
function previousResolverServes(loops: RoutableLoop[], groupId: string | null): string | null {
  const published = loops
    .filter((l) => l.status === "PUBLISHED")
    .sort((a, b) => {
      // ORDER BY "publishedAt" DESC, "updatedAt" DESC; PostgreSQL puts NULLs first for DESC.
      const ap = a.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bp = b.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ap !== bp) return bp > ap ? 1 : -1;
      return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
    });
  let fleetWide: RoutableLoop | null = null;
  const groupLoops = new Map<string, RoutableLoop>();
  for (const l of published) {
    if (l.targetGroupId) {
      if (!groupLoops.has(l.targetGroupId)) groupLoops.set(l.targetGroupId, l);
      continue;
    }
    if (!fleetWide) fleetWide = l;
  }
  const chosen = groupId ? groupLoops.get(groupId) ?? fleetWide : fleetWide;
  return chosen?.manifestUrl ? chosen.id : null; // no manifestUrl -> the manifest route answered 404
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe("legacy data is served exactly as before", () => {
  it("null publishedAt sorts first among legacy publishes, as PostgreSQL DESC did", () => {
    const loops = [loop("dated", { publishedAt: t(9) }), loop("undated", { publishedAt: null })];
    assert.equal(previousResolverServes(loops, null), "undated");
    assert.equal(resolveDeviceLoop({}, snap({ loops })).loop?.id, "undated");
    // ...but any explicit assignment beats an undated legacy publish.
    const explicit = snap({ loops, fleet: { loopId: "dated", at: t(1) } });
    assert.equal(resolveDeviceLoop({}, explicit).loop?.id, "dated");
  });

  it("a legacy winner without a manifest serves nothing and does not fall through", () => {
    const loops = [
      loop("fleet-old", { publishedAt: t(1) }),
      loop("fleet-broken", { publishedAt: t(5), manifestUrl: null }),
      loop("grp-broken", { publishedAt: t(3), manifestUrl: null, targetGroupId: "g1" }),
    ];
    assert.equal(previousResolverServes(loops, null), null);
    assert.equal(previousResolverServes(loops, "g1"), null);
    const s = snap({ loops });
    assert.equal(resolveDeviceLoop({}, s).loop, null);
    assert.equal(resolveDeviceLoop({ groupId: "g1" }, s).loop, null);
    assert.equal(resolveGroupLevel("g1", s).blocked, true);
  });

  it("matches the previous resolver on 50,000 random legacy datasets", () => {
    const random = mulberry32(20261116);
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
    const groupIds = ["g1", "g2", "g3"];
    let devicesChecked = 0;

    for (let round = 0; round < 50_000; round += 1) {
      const count = Math.floor(random() * 7);
      const loops: RoutableLoop[] = [];
      for (let i = 0; i < count; i += 1) {
        loops.push(
          loop(`l${i}`, {
            status: pick(["PUBLISHED", "PUBLISHED", "PUBLISHED", "DRAFT", "ARCHIVED", "PUBLISHING", "REVIEW"]),
            targetGroupId: pick([null, null, "g1", "g2", "ghost"]),
            // Few distinct times so ties happen; null in about one in six.
            publishedAt: pick([t(1), t(2), t(2), t(3), t(4), null]),
            manifestUrl: random() < 0.2 ? null : `http://x/l${i}.json`,
            updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000 + Math.floor(random() * 500)),
            autoLive: true, // every loop that predates the feature
          }),
        );
      }
      const snapshot = buildRoutingSnapshot({
        loops,
        groups: groupIds.map((id) => ({ id, assignedLoopId: null, assignmentAt: null })),
        fleetAssignment: null,
      });
      for (const groupId of [null, ...groupIds]) {
        const before = previousResolverServes(loops, groupId);
        const after = resolveDeviceLoop({ groupId, overrideLoopId: null }, snapshot).loop?.id ?? null;
        if (before !== after) {
          assert.fail(
            `round ${round}, group ${groupId}: was served ${before}, now ${after}\n${JSON.stringify(loops, null, 1)}`,
          );
        }
        devicesChecked += 1;
      }
    }
    assert.equal(devicesChecked, 200_000);
  });
});
