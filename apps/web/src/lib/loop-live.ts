// Where loops are really live, and what a change would do, for the desktop (loops list, builder,
// pause and target-change confirmations). Uses the one resolver (lib/routing-core.ts) and the
// phone API's live-on index (lib/mobile.ts buildLiveOnIndex), so the desktop and the phone always
// agree. describeEffect is pure and unit-tested (test/loop-live.test.ts).

import { createHash } from "node:crypto";

import { prisma, type Prisma } from "@orison/db";

import { getFleetAssignment } from "./loop-routing";
import { buildLiveOnIndex, type LiveOnIndex } from "./mobile";
import {
  buildRoutingSnapshot,
  resolveDeviceLoop,
  resolveFleetLoop,
  resolveGroupLevel,
  type FleetAssignment,
  type RoutingSnapshot,
} from "./routing-core";

const worldLoopSelect = {
  id: true,
  name: true,
  status: true,
  targetGroupId: true,
  autoLive: true,
  manifestUrl: true,
  compiledVideoUrl: true,
  compiledVideoKey: true,
  posterKey: true,
  version: true,
  checksum: true,
  publishedAt: true,
  updatedAt: true,
} satisfies Prisma.LoopSelect;

export type WorldLoop = Prisma.LoopGetPayload<{ select: typeof worldLoopSelect }>;

export type RoutingWorld = {
  loops: WorldLoop[];
  groups: Array<{ id: string; name: string; assignedLoopId: string | null; assignmentAt: Date | null }>;
  fleetAssignment: FleetAssignment | null;
  devices: Array<{ id: string; serialNumber: string; cabLicenseNumber: string | null; groupId: string | null; overrideLoopId: string | null }>;
};

/** Everything routing depends on, in four queries. */
export async function loadRoutingWorld(): Promise<RoutingWorld> {
  const [loops, groups, fleetAssignment, devices] = await Promise.all([
    prisma.loop.findMany({ where: { status: "PUBLISHED" }, select: worldLoopSelect }),
    prisma.deviceGroup.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, assignedLoopId: true, assignmentAt: true },
    }),
    getFleetAssignment(),
    prisma.device.findMany({
      where: { isActive: true },
      select: { id: true, serialNumber: true, cabLicenseNumber: true, groupId: true, overrideLoopId: true },
    }),
  ]);
  return { loops, groups, fleetAssignment, devices };
}

export function snapshotOf(world: RoutingWorld, loops = world.loops): RoutingSnapshot<WorldLoop> {
  return buildRoutingSnapshot({ loops, groups: world.groups, fleetAssignment: world.fleetAssignment });
}

export function liveOnIndexOf(world: RoutingWorld, snapshot = snapshotOf(world)): LiveOnIndex {
  return buildLiveOnIndex(snapshot as never, world.groups, world.devices);
}

export type LiveOn = { fleet: boolean; groups: Array<{ id: string; name: string }>; cabCount: number };

export function liveOnFor(index: LiveOnIndex, loopId: string): LiveOn {
  return {
    fleet: index.fleetLoopId === loopId,
    groups: index.groupsByLoop.get(loopId) ?? [],
    cabCount: index.cabCountByLoop.get(loopId) ?? 0,
  };
}

export function isLiveSomewhere(liveOn: LiveOn) {
  return liveOn.fleet || liveOn.groups.length > 0 || liveOn.cabCount > 0;
}

/** "all cabs (8 cabs)", "group TCR (no cabs yet)", "3 cabs" */
export function describeLiveOn(liveOn: LiveOn) {
  const parts: string[] = [];
  if (liveOn.fleet) parts.push("all cabs");
  for (const group of liveOn.groups) parts.push(`group ${group.name}`);
  const where = parts.join(", ");
  const cabs = `${liveOn.cabCount} cab${liveOn.cabCount === 1 ? "" : "s"}`;
  if (!where) return liveOn.cabCount ? cabs : "nowhere";
  return `${where} (${liveOn.cabCount ? `playing on ${cabs}` : "no cabs playing it right now"})`;
}

type LoopRef = { id: string; name: string } | null;

export type Effect = {
  /** Scope-level changes: what all cabs / a group would play (also counts for cabs added later). */
  levels: Array<{ label: string; from: LoopRef; to: LoopRef }>;
  /** Cabs whose loop would change, grouped by from/to. */
  cabs: Array<{ from: LoopRef; to: LoopRef; count: number; examples: string[] }>;
  changes: boolean;
};

const ref = (loop: { id: string; name: string } | null | undefined): LoopRef => (loop ? { id: loop.id, name: loop.name } : null);

/** What changes between two routing snapshots of the same world (pure). */
export function describeEffect(world: RoutingWorld, before: RoutingSnapshot<WorldLoop>, after: RoutingSnapshot<WorldLoop>): Effect {
  const levels: Effect["levels"] = [];
  const fleetBefore = ref(resolveFleetLoop(before));
  const fleetAfter = ref(resolveFleetLoop(after));
  if (fleetBefore?.id !== fleetAfter?.id) levels.push({ label: "All cabs", from: fleetBefore, to: fleetAfter });
  for (const group of world.groups) {
    const levelBefore = resolveGroupLevel(group.id, before);
    const levelAfter = resolveGroupLevel(group.id, after);
    const fromLoop = levelBefore.loop ? ref(levelBefore.loop) : levelBefore.followFleet ? fleetBefore : null;
    const toLoop = levelAfter.loop ? ref(levelAfter.loop) : levelAfter.followFleet ? fleetAfter : null;
    if (fromLoop?.id !== toLoop?.id) levels.push({ label: `Group ${group.name}`, from: fromLoop, to: toLoop });
  }
  const buckets = new Map<string, Effect["cabs"][number]>();
  for (const device of world.devices) {
    const from = ref(resolveDeviceLoop(device, before).loop);
    const to = ref(resolveDeviceLoop(device, after).loop);
    if (from?.id === to?.id) continue;
    const key = `${from?.id ?? "-"}>${to?.id ?? "-"}`;
    const bucket = buckets.get(key) ?? { from, to, count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < 5) bucket.examples.push(device.cabLicenseNumber || device.serialNumber);
    buckets.set(key, bucket);
  }
  const cabs = [...buckets.values()].sort((a, b) => b.count - a.count);
  return { levels, cabs, changes: levels.length > 0 || cabs.length > 0 };
}

/** A short fingerprint of an effect: a confirmation is only applied if the effect is unchanged. */
export function effectToken(effect: Effect) {
  return createHash("sha256").update(JSON.stringify(effect)).digest("hex").slice(0, 16);
}

/** The effect of taking `loopId` off air. */
export function pauseEffect(world: RoutingWorld, loopId: string) {
  const before = snapshotOf(world);
  const after = snapshotOf(world, world.loops.filter((loop) => loop.id !== loopId));
  return describeEffect(world, before, after);
}

/**
 * The effect of moving a live loop to another target: it competes in its new scope as the newest
 * desktop action (as if published there now), and stops being a candidate in its old scope.
 */
export function targetChangeEffect(world: RoutingWorld, loopId: string, targetGroupId: string | null, now = new Date()) {
  const before = snapshotOf(world);
  const after = snapshotOf(
    world,
    world.loops.map((loop) => (loop.id === loopId ? { ...loop, targetGroupId, publishedAt: now } : loop)),
  );
  return describeEffect(world, before, after);
}

/**
 * Routing as the resolver sees it, for the desktop's devices page and dashboard (owned by the
 * server engineer): per cab its loop and where that comes from (its own override set in the phone
 * app, its group, or all cabs), per group what it plays and whether by the phone app's explicit
 * choice, and what all cabs play.
 */
export async function getRoutingOverview() {
  const world = await loadRoutingWorld();
  const snapshot = snapshotOf(world);
  const fleetLoop = resolveFleetLoop(snapshot);
  const fleetChosenBy =
    fleetLoop && world.fleetAssignment?.loopId === fleetLoop.id
      ? ("phone assignment" as const)
      : fleetLoop
        ? ("desktop publish" as const)
        : null;
  return {
    fleet: { loop: ref(fleetLoop), chosenBy: fleetChosenBy, assignedAt: world.fleetAssignment?.assignedAt ?? null },
    groups: world.groups.map((group) => {
      const level = resolveGroupLevel(group.id, snapshot);
      return {
        id: group.id,
        name: group.name,
        loop: level.loop ? ref(level.loop) : level.followFleet ? ref(fleetLoop) : null,
        followsAllCabs: level.followFleet,
        chosenBy: level.loop
          ? group.assignedLoopId === level.loop.id
            ? ("phone assignment" as const)
            : ("desktop publish" as const)
          : level.explicitFollowFleet
            ? ("phone assignment" as const)
            : null,
        assignedAt: group.assignmentAt,
      };
    }),
    cabs: world.devices.map((device) => {
      const resolution = resolveDeviceLoop(device, snapshot);
      return {
        deviceId: device.id,
        loop: ref(resolution.loop),
        source: resolution.source,
        overrideLoopId: device.overrideLoopId,
        overrideIgnored: Boolean(device.overrideLoopId && resolution.source !== "cab"),
      };
    }),
  };
}
