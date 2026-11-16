// Pure rules for phone uploads (no database access, unit-tested in test/upload-rules.test.ts).

import type { AssignTarget } from "./assignment";
import type { RoutableLoop, RoutingSnapshot } from "./routing-core";

/**
 * While an upload is waiting or being prepared, the server touches the loop row this often
 * (`updatedAt`) to show it is still working on it.
 */
export const UPLOAD_LIVENESS_INTERVAL_MS = 60 * 1000;

/**
 * A phone upload whose row has not been touched for this long is no longer being worked on (the
 * server restarted or the job died) and is reported as failed. Several liveness intervals, so a
 * slow but healthy job is never declared failed.
 */
export const STALE_PUBLISHING_MS = 10 * 60 * 1000;
export const STALE_PUBLISHING_MESSAGE = "Processing was interrupted. Please upload the video again.";
export const STALE_TARGET_STEP_MESSAGE =
  "It was saved to your videos, but processing stopped before it could be put on screens. Choose where it plays from here.";

export function isProcessingStale(updatedAt: Date, now = new Date()) {
  return now.getTime() - updatedAt.getTime() > STALE_PUBLISHING_MS;
}

/**
 * What happens after the conditional publish UPDATE (which only succeeds while the row is still
 * PUBLISHING): a refused publish is discarded and its target is never applied.
 */
export function afterConditionalPublish(input: { publishedRows: number; hasPendingTarget: boolean }) {
  if (input.publishedRows === 0) return "discard" as const;
  return input.hasPendingTarget ? ("apply-target" as const) : ("done" as const);
}

/**
 * When the choice for `target` was last changed by anyone: an explicit assignment (phone) or a
 * desktop publish that made a loop live for that scope. For a cab, its own override (set or
 * cleared). Null if it was never set.
 */
export function targetLastChangedAt<L extends RoutableLoop>(
  target: AssignTarget,
  snapshot: RoutingSnapshot<L>,
  cab?: { overrideAt: Date | null } | null,
): Date | null {
  const times: number[] = [];
  if (target.type === "fleet") {
    if (snapshot.fleetAssignment) times.push(snapshot.fleetAssignment.assignedAt.getTime());
    if (snapshot.legacyFleetLoop?.publishedAt) times.push(snapshot.legacyFleetLoop.publishedAt.getTime());
  } else if (target.type === "group") {
    const assignment = snapshot.groups.get(target.groupId);
    if (assignment?.assignmentAt) times.push(assignment.assignmentAt.getTime());
    const legacy = snapshot.legacyGroupLoops.get(target.groupId);
    if (legacy?.publishedAt) times.push(legacy.publishedAt.getTime());
  } else if (cab?.overrideAt) {
    times.push(cab.overrideAt.getTime());
  }
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * The upload's target is only applied if nobody changed that target after the upload was
 * requested; otherwise the newer choice wins and the video just stays in the library.
 */
export function shouldApplyUploadTarget(lastChangedAt: Date | null, requestedAt: Date) {
  return !lastChangedAt || lastChangedAt.getTime() <= requestedAt.getTime();
}

export function staleTargetMessage(targetLabel: string) {
  return `It wasn't put on ${targetLabel}, because what ${targetLabel} ${
    targetLabel === "all cabs" ? "play" : "plays"
  } was changed while this video was uploading, and that newer choice was kept. You can still put this video on from here.`;
}
