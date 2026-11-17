// Daily pruning of old rows, in the web process (no extra service). Heartbeats are deleted after
// HEARTBEAT_RETENTION_DAYS (default 90; never below 30, which the phone app's cab history needs).
// Playback logs are billing evidence and are kept forever unless PLAYBACK_LOG_RETENTION_DAYS is set.
// Deletes run in small batches so a first run over a large table never holds long locks.

import { prisma } from "@orison/db";

import { env } from "./env";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 5_000;

async function deleteInBatches(table: "DeviceHeartbeat" | "PlaybackLog", column: "receivedAt" | "playedAt", before: Date) {
  let total = 0;
  for (;;) {
    // Identifiers cannot be bound as parameters; both come from the fixed union above.
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE id IN (SELECT id FROM "${table}" WHERE "${column}" < $1 LIMIT ${BATCH})`,
      before,
    );
    total += deleted;
    if (deleted < BATCH) {
      return total;
    }
  }
}

export async function pruneOldRows(now: Date = new Date()) {
  const heartbeatDays = env.heartbeatRetentionDays;
  const playbackDays = env.playbackLogRetentionDays;
  const result = { heartbeats: 0, playbackLogs: 0, heartbeatDays, playbackDays };
  if (heartbeatDays) {
    result.heartbeats = await deleteInBatches("DeviceHeartbeat", "receivedAt", new Date(now.getTime() - heartbeatDays * DAY_MS));
  }
  if (playbackDays) {
    result.playbackLogs = await deleteInBatches("PlaybackLog", "playedAt", new Date(now.getTime() - playbackDays * DAY_MS));
  }
  return result;
}

declare global {
  // eslint-disable-next-line no-var
  var __orisonRetentionTimer: NodeJS.Timeout | undefined;
}

/** Start the daily job once per process: first run 10 minutes after start, then every 24 hours. */
export function scheduleRetention() {
  if (globalThis.__orisonRetentionTimer) {
    return;
  }
  const run = () => {
    pruneOldRows()
      .then((result) => {
        if (result.heartbeats > 0 || result.playbackLogs > 0) {
          console.log(
            `retention: deleted ${result.heartbeats} heartbeats older than ${result.heartbeatDays} days` +
              (result.playbackDays ? ` and ${result.playbackLogs} playback rows older than ${result.playbackDays} days` : ""),
          );
        }
      })
      .catch((error) => console.warn("retention job failed", error));
  };
  const first = setTimeout(() => {
    run();
    globalThis.__orisonRetentionTimer = setInterval(run, DAY_MS);
    globalThis.__orisonRetentionTimer.unref?.();
  }, 10 * 60 * 1000);
  first.unref?.();
  globalThis.__orisonRetentionTimer = first;
}
