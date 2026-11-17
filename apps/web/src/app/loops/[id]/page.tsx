import Link from "next/link";

import { DirectLoopViewer } from "@/components/direct-loop-viewer";
import { LoopBuilder, type AssetOption } from "@/components/loop-builder";
import { LoopStateCard } from "@/components/loop-state-card";
import { PageErrorNotice } from "@/components/page-error-notice";
import { requireUser } from "@/lib/auth";
import { loopFrameFrom } from "@/lib/cms-settings";
import { getLoopBuilderData } from "@/lib/queries";

function assetUrlForKey(key: string | null | undefined) {
  return key ? `/api/storage/${key}` : null;
}

function normaliseMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function mapAsset(asset: {
  id: string;
  filename: string;
  category: string;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumbnailKey: string | null;
  s3Key: string;
  metadata: unknown;
  hiddenAt?: Date | null;
}): AssetOption {
  return {
    id: asset.id,
    filename: asset.filename,
    category: asset.category,
    mimeType: asset.mimeType,
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    thumbnailUrl: assetUrlForKey(asset.thumbnailKey) ?? (asset.mimeType.startsWith("image/") ? assetUrlForKey(asset.s3Key) : null),
    previewUrl: `/api/assets/${asset.id}/preview`,
    metadata: normaliseMetadata(asset.metadata),
    hidden: Boolean(asset.hiddenAt),
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

  if (!data.loop || !data.state || !data.settings) {
    return (
      <div className="page">
        <PageErrorNotice message={data.error} title="Loop data unavailable" />
        <div className="card stack">
          <h1>{data.error ? "This loop could not be loaded" : "Loop not found"}</h1>
          <p className="muted">{data.error ? "Try again in a moment." : "It may have been deleted."}</p>
          <Link className="button button-secondary" href="/loops">
            Back to loops
          </Link>
        </div>
      </div>
    );
  }

  const { loop, state } = data;

  // A pre-built (uploaded) loop with its video, or a loop with neither slots nor video (a phone
  // upload still processing or failed, or an interrupted upload): never a blank page.
  if (loop.slots.length === 0) {
    return (
      <div className="page">
        {loop.compiledVideoKey ? (
          <DirectLoopViewer
            deviceGroups={data.deviceGroups}
            loop={{
              id: loop.id,
              name: loop.name,
              videoUrl: assetUrlForKey(loop.compiledVideoKey),
              manifestUrl: loop.manifestUrl,
              durationMs: loop.durationMs,
              targetGroupId: loop.targetGroupId,
            }}
            state={state}
          />
        ) : (
          <LoopStateCard state={state} />
        )}
      </div>
    );
  }

  // Files used by this loop stay visible here even if they were removed from the library.
  const used = new Map<string, AssetOption>();
  for (const slot of loop.slots) {
    if (slot.staticCreative) used.set(slot.staticCreative.id, mapAsset(slot.staticCreative));
    for (const content of slot.contents) used.set(content.asset.id, mapAsset(content.asset));
  }
  const library = [...data.advertisementAssets, ...data.fillerAssets, ...data.staticCreativeAssets].map(mapAsset);
  for (const asset of library) used.delete(asset.id);
  const assets = [...library, ...used.values()];

  return (
    <div className="page">
      <PageErrorNotice message={data.error} title="Loop data unavailable" />
      <LoopBuilder
        assets={assets}
        deviceGroups={data.deviceGroups}
        fillerTemplate={data.settings.defaultFillerTemplate}
        frame={loopFrameFrom(data.settings)}
        initialState={state}
        loop={{
          id: loop.id,
          name: loop.name,
          updatedAt: loop.updatedAt.toISOString(),
          targetGroupId: loop.targetGroupId,
          slots: loop.slots.map((slot) => ({
            position: slot.position,
            updatedAt: slot.updatedAt.toISOString(),
            staticCreativeId: slot.staticCreativeId,
            contents: slot.contents.map((content) => ({
              assetId: content.assetId,
              orderInSlot: content.orderInSlot,
              startTimeMs: content.startTimeMs,
              durationMs: content.durationMs,
              contentType: content.contentType,
            })),
          })),
        }}
      />
    </div>
  );
}
