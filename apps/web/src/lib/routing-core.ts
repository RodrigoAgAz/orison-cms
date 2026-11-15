// Pure loop-routing rules ("what should this cab play?"). No database access here so the
// rules can be unit-tested; lib/loop-routing.ts loads the snapshot from Prisma.
//
// Rule: the most recent action for a scope wins.
// 1. Cab override (sticky until cleared).
// 2. Group: explicit assignment (DeviceGroup.assignedLoopId/assignmentAt) vs the latest legacy
//    autoLive publish targeted at the group; newer wins. An explicit assignment with a null loop
//    means "follow the fleet".
// 3. Fleet: explicit fleet assignment (SystemSetting fleet-loop-assignment) vs the latest legacy
//    autoLive publish with no target group; newer wins.
// A candidate whose loop is not PUBLISHED with a manifestUrl is skipped and the next candidate
// (the older one in the same scope, then the next scope) is tried.

export type RoutableLoop = {
  id: string;
  name: string;
  status: string;
  targetGroupId: string | null;
  autoLive: boolean;
  manifestUrl: string | null;
  compiledVideoUrl: string | null;
  compiledVideoKey?: string | null;
  posterKey?: string | null;
  version: number;
  checksum: string | null;
  publishedAt: Date | null;
};

export type GroupAssignment = {
  assignedLoopId: string | null;
  assignmentAt: Date | null;
};

export type FleetAssignment = {
  loopId: string;
  assignedAt: Date;
  assignedBy: string | null;
};

export type RoutingSnapshot<L extends RoutableLoop = RoutableLoop> = {
  /** Loops by id. Only loops that may be served need to be present; anything missing is unusable. */
  loops: Map<string, L>;
  groups: Map<string, GroupAssignment>;
  fleetAssignment: FleetAssignment | null;
  /** Latest PUBLISHED autoLive loop per targetGroupId (legacy/desktop publishes). */
  legacyGroupLoops: Map<string, L>;
  /** Latest PUBLISHED autoLive loop with targetGroupId = null. */
  legacyFleetLoop: L | null;
};

export type ExpectedSource = "cab" | "group" | "fleet";

export type Resolution<L extends RoutableLoop = RoutableLoop> = {
  loop: L | null;
  source: ExpectedSource | null;
};

export function isServableLoop(loop: RoutableLoop | null | undefined): loop is RoutableLoop {
  return Boolean(loop && loop.status === "PUBLISHED" && loop.manifestUrl);
}

/** Build the legacy lookups from a list of loops (any order). */
export function buildRoutingSnapshot<L extends RoutableLoop>(input: {
  loops: L[];
  groups: Array<{ id: string } & GroupAssignment>;
  fleetAssignment: FleetAssignment | null;
}): RoutingSnapshot<L> {
  const loops = new Map<string, L>();
  const legacyGroupLoops = new Map<string, L>();
  let legacyFleetLoop: L | null = null;

  const sorted = input.loops
    .filter((loop) => loop.status === "PUBLISHED")
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));

  for (const loop of sorted) {
    loops.set(loop.id, loop);
    if (!loop.autoLive || !loop.manifestUrl) {
      continue;
    }
    if (loop.targetGroupId) {
      if (!legacyGroupLoops.has(loop.targetGroupId)) {
        legacyGroupLoops.set(loop.targetGroupId, loop);
      }
    } else if (!legacyFleetLoop) {
      legacyFleetLoop = loop;
    }
  }

  return {
    loops,
    groups: new Map(input.groups.map((group) => [group.id, group])),
    fleetAssignment: input.fleetAssignment,
    legacyGroupLoops,
    legacyFleetLoop,
  };
}

type Candidate<L> = { at: number; loop: L | null; followFleet: boolean };

function pickNewest<L extends RoutableLoop>(candidates: Candidate<L>[]) {
  // Newest first; on an exact tie the explicit assignment (listed first) wins.
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.at - a.candidate.at || a.index - b.index)
    .map(({ candidate }) => candidate);
}

export function resolveFleetLoop<L extends RoutableLoop>(snapshot: RoutingSnapshot<L>): L | null {
  const candidates: Candidate<L>[] = [];
  if (snapshot.fleetAssignment) {
    candidates.push({
      at: snapshot.fleetAssignment.assignedAt.getTime(),
      loop: snapshot.loops.get(snapshot.fleetAssignment.loopId) ?? null,
      followFleet: false,
    });
  }
  if (snapshot.legacyFleetLoop) {
    candidates.push({
      at: snapshot.legacyFleetLoop.publishedAt?.getTime() ?? 0,
      loop: snapshot.legacyFleetLoop,
      followFleet: false,
    });
  }

  for (const candidate of pickNewest(candidates)) {
    if (isServableLoop(candidate.loop)) {
      return candidate.loop;
    }
  }
  return null;
}

/**
 * Resolve the group level only. Returns `{ followFleet: true }` when the group follows the fleet
 * (explicitly, or because it has no usable group-level candidate).
 */
export function resolveGroupLevel<L extends RoutableLoop>(
  groupId: string,
  snapshot: RoutingSnapshot<L>,
): { loop: L | null; followFleet: boolean; explicitFollowFleet: boolean } {
  const assignment = snapshot.groups.get(groupId);
  const legacy = snapshot.legacyGroupLoops.get(groupId) ?? null;
  const candidates: Candidate<L>[] = [];

  if (assignment?.assignmentAt) {
    candidates.push({
      at: assignment.assignmentAt.getTime(),
      loop: assignment.assignedLoopId ? snapshot.loops.get(assignment.assignedLoopId) ?? null : null,
      followFleet: !assignment.assignedLoopId,
    });
  }
  if (legacy) {
    candidates.push({ at: legacy.publishedAt?.getTime() ?? 0, loop: legacy, followFleet: false });
  }

  for (const candidate of pickNewest(candidates)) {
    if (candidate.followFleet) {
      return { loop: null, followFleet: true, explicitFollowFleet: true };
    }
    if (isServableLoop(candidate.loop)) {
      return { loop: candidate.loop, followFleet: false, explicitFollowFleet: false };
    }
  }
  return { loop: null, followFleet: true, explicitFollowFleet: false };
}

export function resolveDeviceLoop<L extends RoutableLoop>(
  device: { overrideLoopId?: string | null; groupId?: string | null },
  snapshot: RoutingSnapshot<L>,
): Resolution<L> {
  if (device.overrideLoopId) {
    const override = snapshot.loops.get(device.overrideLoopId);
    if (isServableLoop(override)) {
      return { loop: override, source: "cab" };
    }
  }

  if (device.groupId) {
    const group = resolveGroupLevel(device.groupId, snapshot);
    if (group.loop) {
      return { loop: group.loop, source: "group" };
    }
  }

  const fleet = resolveFleetLoop(snapshot);
  return fleet ? { loop: fleet, source: "fleet" } : { loop: null, source: null };
}
