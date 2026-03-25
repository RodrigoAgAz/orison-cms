import { AssetLibrary } from "@/components/asset-library";
import { requireUser } from "@/lib/auth";
import { getAssetLibraryData } from "@/lib/queries";

function assetUrlForKey(key: string | null | undefined) {
  return key ? `/api/storage/${key}` : null;
}

function normaliseMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export default async function AssetsPage() {
  await requireUser();
  const assets = await getAssetLibraryData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Media</span>
          <h1>Asset Library</h1>
          <p className="muted">
            Upload advertisements, filler videos, branded interstitials, and image-based content.
          </p>
        </div>
      </div>

      <AssetLibrary
        assets={assets.map((asset) => ({
          id: asset.id,
          filename: asset.filename,
          category: asset.category,
          status: asset.status,
          mimeType: asset.mimeType,
          durationMs: asset.durationMs,
          width: asset.width,
          height: asset.height,
          fileSize: asset.fileSize,
          thumbnailUrl:
            assetUrlForKey(asset.thumbnailKey) ??
            (asset.mimeType.startsWith("image/") ? assetUrlForKey(asset.s3Key) : null),
          previewUrl: `/api/assets/${asset.id}/preview`,
          metadata: normaliseMetadata(asset.metadata),
          createdAt: asset.createdAt.toISOString(),
          slotPlacements: asset.slotPlacements.map((placement) => ({
            slot: {
              position: placement.slot.position,
              loop: {
                id: placement.slot.loop.id,
                name: placement.slot.loop.name,
                status: placement.slot.loop.status,
              },
            },
          })),
        }))}
      />
    </div>
  );
}
