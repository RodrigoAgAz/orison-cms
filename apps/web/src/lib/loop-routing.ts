import { prisma } from "@orison/db";

type PublishedLoopRecord = {
  id: string;
  name: string;
  targetGroupId: string | null;
  manifestUrl: string | null;
  compiledVideoUrl: string | null;
  version: number;
  checksum: string | null;
  publishedAt: Date | null;
};

export type PublishedLoopRoutingSnapshot = {
  latestPublishedLoop: PublishedLoopRecord | null;
  fleetWideLoop: PublishedLoopRecord | null;
  groupLoops: Map<string, PublishedLoopRecord>;
};

export async function getPublishedLoopRoutingSnapshot(): Promise<PublishedLoopRoutingSnapshot> {
  const publishedLoops = await prisma.loop.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      targetGroupId: true,
      manifestUrl: true,
      compiledVideoUrl: true,
      version: true,
      checksum: true,
      publishedAt: true,
    },
  });

  let fleetWideLoop: PublishedLoopRecord | null = null;
  const groupLoops = new Map<string, PublishedLoopRecord>();

  for (const loop of publishedLoops) {
    if (loop.targetGroupId) {
      if (!groupLoops.has(loop.targetGroupId)) {
        groupLoops.set(loop.targetGroupId, loop);
      }
      continue;
    }

    if (!fleetWideLoop) {
      fleetWideLoop = loop;
    }
  }

  return {
    latestPublishedLoop: publishedLoops[0] ?? null,
    fleetWideLoop,
    groupLoops,
  };
}

export function resolveExpectedLoopForGroup(
  groupId: string | null | undefined,
  snapshot: PublishedLoopRoutingSnapshot,
) {
  if (groupId) {
    return snapshot.groupLoops.get(groupId) ?? snapshot.fleetWideLoop;
  }

  return snapshot.fleetWideLoop;
}
