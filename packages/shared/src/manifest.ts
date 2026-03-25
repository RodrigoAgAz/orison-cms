import { createHash } from "node:crypto";

import { z } from "zod";

export const manifestContentSchema = z.object({
  type: z.enum(["ADVERTISEMENT", "FILLER"]),
  assetId: z.string(),
  filename: z.string(),
  url: z.string().url(),
  checksum: z.string(),
  startTimeMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
  fileSizeBytes: z.number().int().nonnegative(),
});

export const manifestSlotSchema = z.object({
  position: z.number().int().min(0).max(9),
  contents: z.array(manifestContentSchema),
});

export const compiledLoopManifestSchema = z.object({
  version: z.string(),
  loopId: z.string(),
  loopName: z.string(),
  publishedAt: z.string().datetime(),
  checksum: z.string(),
  totalDurationMs: z.number().int().positive(),
  compiledVideoUrl: z.string().url().nullable().optional(),
  compiledVideoChecksum: z.string().optional().nullable(),
  slots: z.array(manifestSlotSchema),
  totalDownloadSizeBytes: z.number().int().nonnegative(),
});

export type CompiledLoopManifest = z.infer<typeof compiledLoopManifestSchema>;

export function checksumJson(payload: unknown) {
  const body = JSON.stringify(payload);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}
