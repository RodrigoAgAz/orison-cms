// The desktop publish job as a small state machine. Pure and client-safe; unit-tested in
// test/publish-state.test.ts. The job itself runs in lib/loop-publish.ts.
//
// A publish never changes a loop's status while it compiles: a live (PUBLISHED) loop keeps
// serving its current compiled video and manifest, a draft stays a draft. The job is recorded in
// three columns: publishJobId (set while a job owns the loop), publishHeartbeatAt (touched every
// PUBLISH_HEARTBEAT_MS by the process running it) and publishProgress (stage and counts). When
// the job finishes, one conditional UPDATE (WHERE publishJobId = <this job>) swaps the new video
// in and clears the job; a job whose heartbeat is older than PUBLISH_STALE_MS died with its
// process (deploy, crash) and is treated as interrupted: the loop can be published again or
// deleted, and the interrupted job can no longer swap anything in.

export const PUBLISH_HEARTBEAT_MS = 10_000;
export const PUBLISH_STALE_MS = 90_000;

export const INTERRUPTED_PUBLISH_MESSAGE =
  "The last publish was interrupted (the server restarted while it was compiling). Nothing changed on any cab. Publish again.";

export const publishStages = [
  "queued",
  "fetching",
  "encoding",
  "assembling",
  "checking",
  "uploading",
  "going-live",
] as const;
export type PublishStage = (typeof publishStages)[number];

export type PublishProgress = {
  stage: PublishStage;
  /** Units done / total within the stage (segments encoded, files fetched). */
  done?: number;
  total?: number;
  startedAt: string;
  userId?: string | null;
  /** The server process running the job (a fresh id per process start). */
  bootId?: string;
  /** Storage keys this job has written but not yet swapped in (removed if it is interrupted). */
  pendingKeys?: string[];
};

export type PublishJobColumns = {
  publishJobId: string | null;
  publishHeartbeatAt: Date | string | null;
  publishProgress: unknown;
};

export type PublishJobView =
  | { kind: "idle" }
  | { kind: "running"; jobId: string; progress: PublishProgress | null; heartbeatAgeMs: number }
  | { kind: "interrupted"; jobId: string; progress: PublishProgress | null };

export function parsePublishProgress(value: unknown): PublishProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.stage !== "string" || !(publishStages as readonly string[]).includes(record.stage)) return null;
  return {
    stage: record.stage as PublishStage,
    done: typeof record.done === "number" ? record.done : undefined,
    total: typeof record.total === "number" ? record.total : undefined,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date(0).toISOString(),
    userId: typeof record.userId === "string" ? record.userId : null,
    bootId: typeof record.bootId === "string" ? record.bootId : undefined,
    pendingKeys: Array.isArray(record.pendingKeys)
      ? record.pendingKeys.filter((key): key is string => typeof key === "string")
      : undefined,
  };
}

export function isHeartbeatStale(at: Date | string | null | undefined, now = new Date(), staleMs = PUBLISH_STALE_MS) {
  if (!at) return true;
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return !Number.isFinite(time) || now.getTime() - time > staleMs;
}

/**
 * `currentBootId`: the id of the process asking. A job started by another process start (the
 * server restarted) whose heartbeat has missed two beats is interrupted at once instead of after
 * PUBLISH_STALE_MS; a job alive in another process keeps beating and is never mistaken for dead.
 */
export function publishJobView(columns: PublishJobColumns, now = new Date(), currentBootId?: string): PublishJobView {
  if (!columns.publishJobId) return { kind: "idle" };
  const progress = parsePublishProgress(columns.publishProgress);
  const otherProcess = Boolean(currentBootId && progress?.bootId && progress.bootId !== currentBootId);
  if (isHeartbeatStale(columns.publishHeartbeatAt, now) || (otherProcess && isHeartbeatStale(columns.publishHeartbeatAt, now, PUBLISH_HEARTBEAT_MS * 2))) {
    return { kind: "interrupted", jobId: columns.publishJobId, progress };
  }
  const at = columns.publishHeartbeatAt!;
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return { kind: "running", jobId: columns.publishJobId, progress, heartbeatAgeMs: Math.max(now.getTime() - time, 0) };
}

/** Message for refusing a status change or delete while a publish is running, or null. */
export function blockedByPublish(view: PublishJobView, action: "pause" | "delete" | "change target" | "publish") {
  if (view.kind !== "running") return null;
  return `This loop is being published. Wait for it to finish before you ${action === "publish" ? "publish it again" : `${action} it`}.`;
}

const stageLabels: Record<PublishStage, string> = {
  queued: "Waiting for another video job to finish",
  fetching: "Fetching files",
  encoding: "Encoding",
  assembling: "Joining the slots",
  checking: "Checking the compiled loop",
  uploading: "Uploading",
  "going-live": "Going live",
};

export function describeProgress(progress: PublishProgress | null) {
  if (!progress) return "Starting";
  const label = stageLabels[progress.stage];
  if (progress.total && progress.total > 0 && progress.done !== undefined) {
    return `${label} (${Math.min(progress.done, progress.total)} of ${progress.total})`;
  }
  return label;
}

/** Overall fraction 0..1 for a progress bar (stages weighted by typical time). */
export function progressFraction(progress: PublishProgress | null) {
  if (!progress) return 0;
  const weights: Record<PublishStage, [number, number]> = {
    queued: [0, 0.02],
    fetching: [0.02, 0.1],
    encoding: [0.1, 0.75],
    assembling: [0.75, 0.82],
    checking: [0.82, 0.88],
    uploading: [0.88, 0.97],
    "going-live": [0.97, 1],
  };
  const [from, to] = weights[progress.stage];
  const within = progress.total ? Math.min((progress.done ?? 0) / progress.total, 1) : 0;
  return from + (to - from) * within;
}

/**
 * What a publish has to do, given what is already compiled and published:
 * - "nothing": same video and same manifest; no new objects, cabs are told exactly what they were;
 * - "manifest": same video (no recompile), but the manifest changes (name, target, safety message,
 *   still images);
 * - "compile": the picture or sound changes.
 */
export function publishWork(
  current: { compiledContentKey: string | null; compiledVideoKey: string | null; manifestContentKey: string | null; manifestKey: string | null },
  next: { compiledContentKey: string; manifestContentKey: string },
): "nothing" | "manifest" | "compile" {
  if (!current.compiledVideoKey || current.compiledContentKey !== next.compiledContentKey) return "compile";
  if (!current.manifestKey || current.manifestContentKey !== next.manifestContentKey) return "manifest";
  return "nothing";
}
