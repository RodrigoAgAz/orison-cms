// In-process queue for phone uploads: one is prepared (ffmpeg) at a time and later ones wait.
// While a loop is queued or being prepared its row is touched every minute, so the phone can tell
// a slow job from one that died (see upload-rules.ts STALE_PUBLISHING_MS).

import { prisma } from "@orison/db";

import { createLimiter, processSingleton } from "./job-limits";
import { UPLOAD_LIVENESS_INTERVAL_MS } from "./upload-rules";

export type UploadJobState = "waiting" | "running";

type QueueState = {
  limiter: ReturnType<typeof createLimiter>;
  jobs: Map<string, UploadJobState>;
  timer: NodeJS.Timeout | null;
};

const queue = processSingleton<QueueState>("upload-queue", () => ({
  limiter: createLimiter(1),
  jobs: new Map(),
  timer: null,
}));

async function touchLiveJobs() {
  const ids = [...queue.jobs.keys()];
  if (ids.length === 0) return;
  await prisma.loop
    .updateMany({ where: { id: { in: ids } }, data: { updatedAt: new Date() } })
    .catch((error) => console.warn("could not record upload liveness", error));
}

function ensureTimer() {
  if (queue.timer || queue.jobs.size === 0) return;
  queue.timer = setInterval(() => {
    if (queue.jobs.size === 0) {
      if (queue.timer) clearInterval(queue.timer);
      queue.timer = null;
      return;
    }
    void touchLiveJobs();
  }, UPLOAD_LIVENESS_INTERVAL_MS);
  queue.timer.unref?.();
}

/** Queue `task` for `loopId`; resolves when it has run. Tasks run one at a time, in order. */
export function enqueueUploadJob(loopId: string, task: () => Promise<void>) {
  queue.jobs.set(loopId, "waiting");
  ensureTimer();
  return queue.limiter
    .run(async () => {
      queue.jobs.set(loopId, "running");
      await task();
    })
    .finally(() => {
      queue.jobs.delete(loopId);
    });
}

/** "waiting" (queued behind another upload), "running", or null if this process has no job for it. */
export function uploadJobState(loopId: string): UploadJobState | null {
  return queue.jobs.get(loopId) ?? null;
}

/** Number of uploads queued ahead of `loopId` (0 when it is running or unknown). */
export function uploadsAhead(loopId: string) {
  if (queue.jobs.get(loopId) !== "waiting") return 0;
  let ahead = 0;
  for (const [id, state] of queue.jobs) {
    if (id === loopId) break;
    if (state === "waiting" || state === "running") ahead += 1;
  }
  return ahead;
}
