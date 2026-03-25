import Link from "next/link";

import type { AssetCategory } from "@orison/shared/src/constants";

import { LoopBuilder } from "@/components/loop-builder";
import { requireUser } from "@/lib/auth";
import { getLoopBuilderData } from "@/lib/queries";

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

function mapAsset(asset: {
  id: string;
  filename: string;
  category: AssetCategory;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fileSize: number;
  thumbnailKey: string | null;
  s3Key: string;
  metadata: unknown;
}) {
  return {
    id: asset.id,
    filename: asset.filename,
    category: asset.category,
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
  };
}

type Props = {
  params: {
    id: string;
  };
};

export default async function LoopBuilderPage({ params }: Props) {
  await requireUser();
  const data = await getLoopBuilderData(params.id);

  if (!data.loop) {
    return (
      <div className="page">
        <div className="card stack">
          <h1>Loop not found</h1>
          <Link className="button button-secondary" href="/loops">
            Back to loops
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <LoopBuilder
        advertisementAssets={data.advertisementAssets.map(mapAsset)}
        fillerAssets={data.fillerAssets.map(mapAsset)}
        fillerTemplate={data.settings.defaultFillerTemplate}
        loop={{
          ...data.loop,
          slots: data.loop.slots.map((slot) => ({
            ...slot,
            contents: slot.contents.map((content) => ({
              ...content,
              asset: mapAsset(content.asset),
            })),
          })),
        }}
      />
    </div>
  );
}
