import { prisma, type Prisma } from "@orison/db";

import {
  buildRoutingSnapshot,
  resolveDeviceLoop,
  resolveFleetLoop,
  resolveGroupLevel,
  type FleetAssignment,
  type RoutingSnapshot,
} from "./routing-core";

export { resolveDeviceLoop, resolveFleetLoop, resolveGroupLevel, isServableLoop } from "./routing-core";
export type { ExpectedSource, Resolution } from "./routing-core";

export const FLEET_LOOP_ASSIGNMENT_KEY = "fleet-loop-assignment";

const routableLoopSelect = {
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

export type RoutedLoop = Prisma.LoopGetPayload<{ select: typeof routableLoopSelect }>;
export type LoopRoutingSnapshot = RoutingSnapshot<RoutedLoop>;

function parseFleetAssignment(value: unknown): FleetAssignment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.loopId !== "string" || typeof record.assignedAt !== "string") {
    return null;
  }
  const assignedAt = new Date(record.assignedAt);
  if (Number.isNaN(assignedAt.getTime())) {
    return null;
  }
  return {
    loopId: record.loopId,
    assignedAt,
    assignedBy: typeof record.assignedBy === "string" ? record.assignedBy : null,
  };
}

export async function getFleetAssignment() {
  const row = await prisma.systemSetting.findUnique({ where: { key: FLEET_LOOP_ASSIGNMENT_KEY } });
  return parseFleetAssignment(row?.value);
}

export async function setFleetAssignment(loopId: string, assignedBy: string | null, at = new Date()) {
  const value = { loopId, assignedAt: at.toISOString(), assignedBy };
  await prisma.systemSetting.upsert({
    where: { key: FLEET_LOOP_ASSIGNMENT_KEY },
    update: { value },
    create: { key: FLEET_LOOP_ASSIGNMENT_KEY, value },
  });
}

/** Loads everything the resolver needs in three queries. */
export async function getLoopRoutingSnapshot(): Promise<LoopRoutingSnapshot> {
  const [loops, groups, fleetAssignment] = await Promise.all([
    prisma.loop.findMany({ where: { status: "PUBLISHED" }, select: routableLoopSelect }),
    prisma.deviceGroup.findMany({ select: { id: true, assignedLoopId: true, assignmentAt: true } }),
    getFleetAssignment(),
  ]);

  return buildRoutingSnapshot({ loops, groups, fleetAssignment });
}

/** Effective loop for a group's members (no cab override), plus whether it comes from the fleet. */
export function resolveGroupLoop(groupId: string, snapshot: LoopRoutingSnapshot) {
  const level = resolveGroupLevel(groupId, snapshot);
  if (level.loop) {
    return { loop: level.loop, followsFleet: false };
  }
  if (level.blocked) {
    return { loop: null, followsFleet: false };
  }
  return { loop: resolveFleetLoop(snapshot), followsFleet: true };
}

export async function resolveExpectedLoopForDevice(device: {
  overrideLoopId: string | null;
  groupId: string | null;
}) {
  const snapshot = await getLoopRoutingSnapshot();
  return resolveDeviceLoop(device, snapshot);
}
