import { z } from "zod";

import { prisma } from "@orison/db";

import { logActivity } from "./activity";
import { ApiError } from "./http";
import { getLoopRoutingSnapshot, resolveDeviceLoop, setFleetAssignment } from "./loop-routing";

export const assignTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fleet") }),
  z.object({ type: z.literal("group"), groupId: z.string().min(1) }),
  z.object({ type: z.literal("cab"), deviceId: z.string().min(1) }),
]);

export const assignBodySchema = z.object({
  loopId: z.string().min(1).nullable(),
  target: assignTargetSchema,
});

export type AssignTarget = z.infer<typeof assignTargetSchema>;

/** Validate that the target exists. Returns a human label for messages. */
export async function describeTarget(target: AssignTarget) {
  if (target.type === "fleet") {
    return { label: "all cabs" };
  }
  if (target.type === "group") {
    const group = await prisma.deviceGroup.findUnique({ where: { id: target.groupId }, select: { name: true } });
    if (!group) {
      throw new ApiError("Group not found", 404);
    }
    return { label: `group ${group.name}` };
  }
  const device = await prisma.device.findUnique({
    where: { id: target.deviceId },
    select: { serialNumber: true, cabLicenseNumber: true },
  });
  if (!device) {
    throw new ApiError("Cab not found", 404);
  }
  return { label: `cab ${device.cabLicenseNumber || device.serialNumber}` };
}

/**
 * Apply an explicit assignment ("most recent action wins").
 * - fleet: loopId required.
 * - group: loopId null -> follow the fleet.
 * - cab: loopId null -> clear the override.
 * Returns affectedCabs (and their ids) = active cabs whose expected loop is now decided by this target
 * (fleet: cabs resolving via the fleet; group: members without a cab override; cab: 1).
 */
export async function assignLoop(
  input: { loopId: string | null; target: AssignTarget },
  user: { id: string; name: string; anonymous?: boolean; ip?: string | null; forwardedFor?: string | null },
) {
  const { target, loopId } = input;
  if (target.type === "fleet" && !loopId) {
    throw new ApiError("Choose a loop for all cabs (loopId cannot be null for the fleet)", 400);
  }

  let loopName: string | null = null;
  if (loopId) {
    const loop = await prisma.loop.findUnique({
      where: { id: loopId },
      select: { id: true, name: true, status: true, manifestUrl: true },
    });
    if (!loop) {
      throw new ApiError("Loop not found", 404);
    }
    if (loop.status !== "PUBLISHED" || !loop.manifestUrl) {
      throw new ApiError(
        loop.status === "ARCHIVED"
          ? `"${loop.name}" is archived, so it cannot be put live`
          : `"${loop.name}" is not published yet, so it cannot be put live`,
        400,
      );
    }
    loopName = loop.name;
  }

  const { label } = await describeTarget(target);
  const now = new Date();

  if (target.type === "fleet") {
    await setFleetAssignment(loopId!, user.id, now);
  } else if (target.type === "group") {
    await prisma.deviceGroup.update({
      where: { id: target.groupId },
      data: { assignedLoopId: loopId, assignmentAt: now, assignedBy: user.id },
    });
  } else {
    await prisma.device.update({
      where: { id: target.deviceId },
      data: loopId
        ? { overrideLoopId: loopId, overrideAt: now, overrideBy: user.id }
        : { overrideLoopId: null, overrideAt: now, overrideBy: user.id },
    });
  }

  const [snapshot, devices] = await Promise.all([
    getLoopRoutingSnapshot(),
    prisma.device.findMany({
      where: { isActive: true },
      select: { id: true, groupId: true, overrideLoopId: true },
    }),
  ]);
  const affectedCabIds: string[] = [];
  for (const device of devices) {
    const { source } = resolveDeviceLoop(device, snapshot);
    if (
      (target.type === "fleet" && source === "fleet") ||
      (target.type === "group" && device.groupId === target.groupId && source !== "cab") ||
      (target.type === "cab" && device.id === target.deviceId)
    ) {
      affectedCabIds.push(device.id);
    }
  }
  const affectedCabs = affectedCabIds.length;

  const message =
    target.type === "group" && !loopId
      ? `${user.name} set ${label} to follow the fleet`
      : target.type === "cab" && !loopId
        ? `${user.name} cleared the override on ${label}`
        : `${user.name} put "${loopName}" on ${label}`;
  await logActivity("LOOP_ASSIGNED", message, {
    loopId,
    loopName,
    target,
    userId: user.id,
    userName: user.name,
    ...(user.anonymous ? { anonymous: true, ip: user.ip ?? null, forwardedFor: user.forwardedFor ?? null } : {}),
    affectedCabs,
  });

  // affectedCabIds is additive: the phone lists exactly these cabs on its "Done" screen.
  return { ok: true as const, affectedCabs, affectedCabIds };
}
