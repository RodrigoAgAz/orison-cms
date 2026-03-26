import { assetCategories, type AssetCategory } from "@orison/shared/src/constants";

import { AssetLibrary } from "@/components/asset-library";
import { PageErrorNotice } from "@/components/page-error-notice";
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

type Props = {
  searchParams?: {
    page?: string;
    search?: string;
    category?: string;
  };
};

function parsePage(value: string | undefined) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function parseCategory(value: string | undefined): AssetCategory | "ALL" {
  if (!value || value === "ALL") {
    return "ALL";
  }

  return assetCategories.includes(value as AssetCategory) ? (value as AssetCategory) : "ALL";
}

export default async function AssetsPage({ searchParams }: Props) {
  await requireUser();
  const page = parsePage(searchParams?.page);
  const result = await getAssetLibraryData({
    page,
    pageSize: 18,
    search: searchParams?.search,
    category: parseCategory(searchParams?.category),
  });

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

      <PageErrorNotice message={result.error} title="Asset library unavailable" />

      <AssetLibrary
        assets={result.items.map((asset) => ({
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
          slotUsages: [
            ...asset.slotPlacements.map((placement) => ({
              usageType: "VIDEO" as const,
              slot: {
                position: placement.slot.position,
                loop: {
                  id: placement.slot.loop.id,
                  name: placement.slot.loop.name,
                  status: placement.slot.loop.status,
                },
              },
            })),
            ...asset.staticSlots.map((slot) => ({
              usageType: "STATIC" as const,
              slot: {
                position: slot.position,
                loop: {
                  id: slot.loop.id,
                  name: slot.loop.name,
                  status: slot.loop.status,
                },
              },
            })),
          ],
        }))}
        currentCategory={result.category}
        currentQuery={result.search}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
      />
    </div>
  );
}
