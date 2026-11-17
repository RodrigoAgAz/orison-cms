// Explicit, confirmed, logged actions on loops from the desktop: take a live loop off air (pause),
// change where a live loop plays, rename. Each one that changes what cabs play first answers with
// what will change on which cabs and a token; it is applied only when called again with the same
// token (so a confirmation can never apply a different change than the one shown).
//
// One set of rules for taking a loop out of play (shared with the phone app's archive, see
// archiveMobileLoop in lib/mobile.ts): never while it is being published or while a phone upload
// is still being processed or put on screens; a loop that is live needs the confirmation.

import { prisma } from "@orison/db";

import { logActivity } from "./activity";
import { effectToken, isLiveSomewhere, liveOnFor, liveOnIndexOf, loadRoutingWorld, pauseEffect, targetChangeEffect, type Effect } from "./loop-live";
import { assertNotPublishing, PublishRefused } from "./loop-publish";
import { StaleEditError } from "./loops";

export type ConfirmationNeeded = { needsConfirmation: true; effect: Effect; token: string; message: string };

type Actor = { id: string; name?: string | null };

function describeRef(loop: { name: string } | null) {
  return loop ? `"${loop.name}"` : "nothing new (cabs keep playing the copy they already have)";
}

/** Plain-words lines for a confirmation dialog. */
export function effectLines(effect: Effect) {
  const lines: string[] = [];
  for (const level of effect.levels) {
    lines.push(`${level.label}: ${describeRef(level.from)} → ${describeRef(level.to)}`);
  }
  for (const bucket of effect.cabs) {
    lines.push(
      `${bucket.count} cab${bucket.count === 1 ? "" : "s"} (${bucket.examples.join(", ")}${bucket.count > bucket.examples.length ? ", …" : ""}): ${describeRef(bucket.from)} → ${describeRef(bucket.to)}`,
    );
  }
  return lines;
}

/** One rule set for taking a loop out of play. Throws PublishRefused with the reason. */
async function assertCanTakeOutOfPlay(loop: { id: string; status: string; pendingTargetAt: Date | null }) {
  await assertNotPublishing(loop.id, "pause");
  if (loop.status === "PUBLISHING") {
    throw new PublishRefused("This video is still being processed. Wait for it to finish first.");
  }
  if (loop.pendingTargetAt) {
    throw new PublishRefused("This video is still being put on screens. Wait a moment and try again.");
  }
}

/**
 * Take a loop off air (status ARCHIVED, shown as "Paused"). Its compiled video is kept, so
 * publishing it again with no changes puts it back at once without recompiling.
 */
export async function pauseLoop(loopId: string, actor: Actor, token?: string | null): Promise<ConfirmationNeeded | { paused: true; effect: Effect }> {
  const loop = await prisma.loop.findUnique({ where: { id: loopId } });
  if (!loop) throw new PublishRefused("Loop not found", 404);
  if (loop.status !== "PUBLISHED") throw new PublishRefused("This loop is not on air.");
  await assertCanTakeOutOfPlay(loop);

  const world = await loadRoutingWorld();
  const liveOn = liveOnFor(liveOnIndexOf(world), loop.id);
  const effect = pauseEffect(world, loop.id);
  const expected = effectToken(effect);
  if (isLiveSomewhere(liveOn) && token !== expected) {
    return {
      needsConfirmation: true,
      effect,
      token: expected,
      message: `"${loop.name}" is live. Pausing it changes what these cabs play:`,
    };
  }

  const updated = await prisma.loop.updateMany({
    where: { id: loop.id, status: "PUBLISHED", publishJobId: null },
    data: { status: "ARCHIVED" },
  });
  if (updated.count === 0) throw new PublishRefused("The loop changed while it was being paused. Reload and try again.");
  await logActivity("LOOP_ARCHIVED", `Loop ${loop.name} taken off air (paused)${actor.name ? ` by ${actor.name}` : ""}`, {
    loopId: loop.id,
    userId: actor.id,
    effect: JSON.parse(JSON.stringify(effect)),
  });
  return { paused: true, effect };
}

/**
 * Change where a loop plays. For a loop that is not on air this only changes where its next
 * publish goes. For a live loop it is an explicit, confirmed action: the loop moves to the new
 * target now (as the newest action there) and stops playing where it was.
 */
export async function changeLoopTarget(
  loopId: string,
  targetGroupId: string | null,
  actor: Actor,
  options: { token?: string | null; expectedUpdatedAt?: string | null } = {},
): Promise<ConfirmationNeeded | { changed: true; live: boolean; effect: Effect | null }> {
  const loop = await prisma.loop.findUnique({ where: { id: loopId }, include: { targetGroup: { select: { name: true } } } });
  if (!loop) throw new PublishRefused("Loop not found", 404);
  if (options.expectedUpdatedAt && loop.updatedAt.toISOString() !== options.expectedUpdatedAt) {
    throw new StaleEditError("This loop was changed by someone else after you opened it. Reload to see their version.");
  }
  await assertNotPublishing(loop.id, "change target");
  const group = targetGroupId ? await prisma.deviceGroup.findUnique({ where: { id: targetGroupId }, select: { name: true } }) : null;
  if (targetGroupId && !group) throw new PublishRefused("That group no longer exists.", 400);
  if ((loop.targetGroupId ?? null) === targetGroupId) return { changed: true, live: loop.status === "PUBLISHED", effect: null };

  const from = loop.targetGroup ? `group ${loop.targetGroup.name}` : "all cabs";
  const to = group ? `group ${group.name}` : "all cabs";

  if (loop.status !== "PUBLISHED" || !loop.autoLive) {
    await prisma.loop.update({ where: { id: loop.id }, data: { targetGroupId } });
    return { changed: true, live: false, effect: null };
  }

  const world = await loadRoutingWorld();
  const effect = targetChangeEffect(world, loop.id, targetGroupId);
  const expected = effectToken(effect);
  if (options.token !== expected) {
    return {
      needsConfirmation: true,
      effect,
      token: expected,
      message: `"${loop.name}" is on air. Moving it from ${from} to ${to} takes effect on cabs now (no new publish):`,
    };
  }
  const now = new Date();
  const updated = await prisma.loop.updateMany({
    where: { id: loop.id, status: "PUBLISHED", publishJobId: null, targetGroupId: loop.targetGroupId },
    data: { targetGroupId, publishedAt: now },
  });
  if (updated.count === 0) throw new PublishRefused("The loop changed while it was being moved. Reload and try again.");
  await logActivity("LOOP_ASSIGNED", `Loop ${loop.name} moved from ${from} to ${to}${actor.name ? ` by ${actor.name}` : ""}`, {
    loopId: loop.id,
    userId: actor.id,
    fromGroupId: loop.targetGroupId,
    toGroupId: targetGroupId,
    effect: JSON.parse(JSON.stringify(effect)),
  });
  return { changed: true, live: true, effect };
}

export async function renameLoop(loopId: string, name: string, expectedUpdatedAt?: string | null) {
  const loop = await prisma.loop.findUnique({ where: { id: loopId }, select: { id: true, updatedAt: true } });
  if (!loop) throw new PublishRefused("Loop not found", 404);
  if (expectedUpdatedAt && loop.updatedAt.toISOString() !== expectedUpdatedAt) {
    throw new StaleEditError("This loop was renamed or changed by someone else after you opened it. Reload to see their version.");
  }
  return prisma.loop.update({ where: { id: loop.id }, data: { name } });
}
