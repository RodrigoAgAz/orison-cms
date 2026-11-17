// The safety message configured in Settings, as the cabs are told about it. The manifest route
// returns it on every poll and the heartbeat returns its checksum, so changing it in Settings
// reaches cabs on firmware 1.2.0+ without republishing every loop (DEVICE_CONTRACT_V2).
// Same eligibility rules as the copy written into manifest files at publish (lib/loops.ts).

import { prisma } from "@orison/db";

import { getCmsSettings } from "./cms-settings";
import { getPublicUrl } from "./storage";

export type SafetyMessage = {
  assetId: string;
  url: string;
  checksum: string | null;
  durationMs: number;
  mimeType: string;
};

/**
 * What to tell cabs. "none": nothing is configured, so cabs must remove theirs (firmware 1.2.0
 * treats safetyVideo: null that way). "unusable": something is configured but cannot be served
 * right now (asset missing, still processing, wrong type): say nothing, so cabs keep what they
 * have. "ok": serve it.
 */
export async function resolveSafetyMessageForCabs(
  settings?: Awaited<ReturnType<typeof getCmsSettings>>,
): Promise<{ state: "none" } | { state: "unusable" } | { state: "ok"; message: SafetyMessage }> {
  const current = settings ?? (await getCmsSettings());
  if (!current.safetyVideoAssetId) {
    return { state: "none" };
  }
  const message = await loadSafetyMessage(current);
  return message ? { state: "ok", message } : { state: "unusable" };
}

/** The configured safety message if it can be served, else null (for display). */
export async function getConfiguredSafetyMessage(
  settings?: Awaited<ReturnType<typeof getCmsSettings>>,
): Promise<SafetyMessage | null> {
  const current = settings ?? (await getCmsSettings());
  return current.safetyVideoAssetId ? loadSafetyMessage(current) : null;
}

async function loadSafetyMessage(current: Awaited<ReturnType<typeof getCmsSettings>>): Promise<SafetyMessage | null> {
  if (!current.safetyVideoAssetId) {
    return null;
  }
  const asset = await prisma.asset.findUnique({
    where: { id: current.safetyVideoAssetId },
    select: { id: true, s3Key: true, checksum: true, durationMs: true, mimeType: true, status: true, category: true },
  });
  if (!asset || asset.status !== "READY" || asset.category !== "SAFETY_MESSAGE" || !asset.mimeType) {
    return null;
  }
  const durationMs = asset.mimeType.startsWith("image/")
    ? current.safetyMessageDurationSeconds * 1000
    : asset.durationMs ?? 0;
  if (durationMs <= 0) {
    return null;
  }
  return {
    assetId: asset.id,
    url: getPublicUrl(asset.s3Key),
    checksum: asset.checksum ?? null,
    durationMs,
    mimeType: asset.mimeType,
  };
}
