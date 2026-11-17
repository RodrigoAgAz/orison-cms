import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Temp folder prefixes used by uploads and media jobs (see upload-stream.ts and loops.ts). */
export const UPLOAD_TEMP_PREFIXES = [
  "orison-mobile-upload-",
  "orison-mobile-loop-",
  "orison-direct-upload-",
  "orison-direct-loop-",
  "orison-loop-",
  "orison-poster-",
  // Desktop asset uploads (streamed body) and their processing.
  "orison-asset-",
] as const;

/**
 * Remove upload/media temp folders left behind by an interrupted upload or a restart. Runs at
 * server start. Only folders not modified for `minAgeMs` are removed, so another process on the
 * same machine that is mid-upload is left alone.
 */
export async function removeStaleUploadTempDirs(options: { root?: string; minAgeMs?: number; now?: number } = {}) {
  const root = options.root ?? os.tmpdir();
  const minAgeMs = options.minAgeMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!UPLOAD_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const dir = path.join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      let newest = info.mtimeMs;
      for (const child of await readdir(dir)) {
        const childInfo = await stat(path.join(dir, child)).catch(() => null);
        if (childInfo) newest = Math.max(newest, childInfo.mtimeMs);
      }
      if (now - newest < minAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // vanished or unreadable: leave it
    }
  }
  return removed;
}
