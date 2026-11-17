// Removing assets from the library (FIXES-LOOPS U9): staff can always get an asset out of the
// library. It is deleted when nothing uses it; when loops still use it, it is hidden from the
// library and its file kept for them (deleted later, once the last loop using it is deleted).

import { prisma } from "@orison/db";

import { getCmsSettings } from "./cms-settings";
import { ApiError } from "./http";
import { deleteObject } from "./storage";

export async function removeAssetFromLibrary(assetId: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: {
      slotPlacements: { select: { slot: { select: { loop: { select: { id: true, name: true } } } } } },
      staticSlots: { select: { loop: { select: { id: true, name: true } } } },
    },
  });
  if (!asset) {
    throw new ApiError("Asset not found", 404);
  }
  const settings = await getCmsSettings();
  if (settings.safetyVideoAssetId === asset.id) {
    throw new ApiError(`"${asset.filename}" is the safety message chosen in Settings. Choose another safety message first.`, 409);
  }
  if (asset.status === "PROCESSING") {
    throw new ApiError(`"${asset.filename}" is still being processed. Wait for it to finish, then remove it.`, 409);
  }

  const loops = new Map<string, string>();
  for (const placement of asset.slotPlacements) loops.set(placement.slot.loop.id, placement.slot.loop.name);
  for (const slot of asset.staticSlots) loops.set(slot.loop.id, slot.loop.name);

  if (loops.size > 0) {
    await prisma.asset.update({ where: { id: asset.id }, data: { hiddenAt: asset.hiddenAt ?? new Date() } });
    const names = [...loops.values()];
    return {
      outcome: "hidden" as const,
      loops: [...loops].map(([id, name]) => ({ id, name })),
      message: `"${asset.filename}" was removed from the library. Its file is kept because ${
        names.length === 1 ? `the loop "${names[0]}" uses it` : `${names.length} loops use it (${names.slice(0, 3).map((name) => `"${name}"`).join(", ")}${names.length > 3 ? ", …" : ""})`
      }; it is deleted for good once no loop uses it.`,
    };
  }

  await deleteAssetRowAndFiles(asset);
  return { outcome: "deleted" as const, loops: [], message: `"${asset.filename}" was deleted.` };
}

async function deleteAssetRowAndFiles(asset: { id: string; s3Key: string; thumbnailKey: string | null }) {
  await prisma.asset.delete({ where: { id: asset.id } });
  await deleteObject(asset.s3Key).catch(() => undefined);
  if (asset.thumbnailKey) await deleteObject(asset.thumbnailKey).catch(() => undefined);
}

/** Delete hidden assets that no loop uses any more (after a loop was deleted or edited). */
export async function purgeUnusedHiddenAssets() {
  const settings = await getCmsSettings();
  const orphans = await prisma.asset.findMany({
    where: {
      hiddenAt: { not: null },
      slotPlacements: { none: {} },
      staticSlots: { none: {} },
      ...(settings.safetyVideoAssetId ? { id: { not: settings.safetyVideoAssetId } } : {}),
    },
    select: { id: true, s3Key: true, thumbnailKey: true },
  });
  for (const asset of orphans) {
    await deleteAssetRowAndFiles(asset).catch((error) => console.warn(`could not delete hidden asset ${asset.id}`, error));
  }
  return orphans.length;
}

/** Assets left PROCESSING by a restart (their temp file is gone) are marked failed. */
export async function failInterruptedAssetProcessing(now = new Date()) {
  await prisma.asset.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } },
    data: { status: "FAILED", errorMessage: "Processing was interrupted (the server restarted). Upload the file again." },
  });
}
