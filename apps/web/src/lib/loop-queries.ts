// Page data for the loops list, the loop builder, the asset library and settings (re-exported by
// lib/queries.ts under the names the pages have always used).

import { prisma, type Prisma } from "@orison/db";
import type { AssetCategory } from "@orison/shared/src/constants";

import { failInterruptedAssetProcessing } from "./asset-removal";
import { getCmsSettings, loopFrameFrom } from "./cms-settings";
import { draftKeyOf, hasUnpublishedChanges } from "./loop-plan";
import { describeLiveOn, isLiveSomewhere, liveOnFor, liveOnIndexOf, loadRoutingWorld, type LiveOn } from "./loop-live";
import { recoverInterruptedPublishes } from "./loop-publish";
import { describeProgress, progressFraction, publishJobView } from "./publish-state";
import { publishSlotProblems } from "./slot-rules";

function formatQueryFailure(scope: string, error: unknown) {
  console.error(error);
  return `${scope} could not be loaded. Check the server logs and refresh.`;
}

/** Clamp a requested page into range (a page past the end shows the last page). */
export function clampPage(page: number, pageSize: number, total: number) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(Math.max(1, page), pageCount), pageCount };
}

const listLoopSelect = {
  id: true,
  name: true,
  status: true,
  updatedAt: true,
  publishedAt: true,
  version: true,
  autoLive: true,
  durationMs: true,
  compiledVideoKey: true,
  manifestKey: true,
  publishError: true,
  targetGroupId: true,
  publishJobId: true,
  publishHeartbeatAt: true,
  publishProgress: true,
  publishedDraftKey: true,
  targetGroup: { select: { id: true, name: true } },
  slots: {
    select: {
      position: true,
      updatedAt: true,
      staticCreativeId: true,
      contents: {
        select: {
          assetId: true,
          orderInSlot: true,
          startTimeMs: true,
          durationMs: true,
          contentType: true,
          asset: { select: { checksum: true } },
        },
      },
    },
  },
} satisfies Prisma.LoopSelect;

type ListLoop = Prisma.LoopGetPayload<{ select: typeof listLoopSelect }>;

export type LoopKind = "builder" | "prebuilt" | "phone";

export function loopKindOf(loop: { autoLive: boolean; slots: unknown[] }): LoopKind {
  if (loop.slots.length > 0) return "builder";
  return loop.autoLive ? "prebuilt" : "phone";
}

export type PublishStateSummary = {
  kind: "idle" | "running" | "interrupted";
  label: string | null;
  fraction: number;
  startedAt: string | null;
};

export function publishStateSummary(loop: Pick<ListLoop, "publishJobId" | "publishHeartbeatAt" | "publishProgress">): PublishStateSummary {
  const view = publishJobView(loop);
  if (view.kind === "idle") return { kind: "idle", label: null, fraction: 0, startedAt: null };
  if (view.kind === "interrupted") return { kind: "interrupted", label: "Interrupted", fraction: 0, startedAt: view.progress?.startedAt ?? null };
  return { kind: "running", label: describeProgress(view.progress), fraction: progressFraction(view.progress), startedAt: view.progress?.startedAt ?? null };
}

/** The state the list and the builder show (and poll) for one loop. */
export function loopStateOf(loop: ListLoop, liveOn: LiveOn, frame: { width: number; height: number }) {
  const kind = loopKindOf(loop);
  const readySlots = loop.slots.filter((slot) => slot.contents.length > 0 && publishSlotProblems(slot.contents.map(({ asset: _asset, ...content }) => content)).length === 0).length;
  const lastSlotEditAt = loop.slots.reduce<Date | null>((latest, slot) => (!latest || slot.updatedAt > latest ? slot.updatedAt : latest), null);
  const unpublishedChanges =
    kind === "builder" &&
    hasUnpublishedChanges({
      publishedAt: loop.publishedAt,
      publishedDraftKey: loop.publishedDraftKey,
      currentDraftKey: draftKeyOf(loop.slots, frame),
      lastSlotEditAt,
    });
  return {
    id: loop.id,
    name: loop.name,
    status: loop.status,
    kind,
    updatedAt: loop.updatedAt.toISOString(),
    publishedAt: loop.publishedAt?.toISOString() ?? null,
    version: loop.version,
    durationMs: loop.durationMs,
    hasVideo: Boolean(loop.compiledVideoKey),
    publishError: readablePublishError(loop.publishError),
    targetGroupId: loop.targetGroupId,
    targetLabel: loop.targetGroup ? `Group ${loop.targetGroup.name}` : "All cabs",
    readySlots,
    slotCount: loop.slots.length,
    liveOn,
    live: isLiveSomewhere(liveOn),
    liveLabel: describeLiveOn(liveOn),
    publish: publishStateSummary(loop),
    unpublishedChanges,
  };
}

/**
 * Publishes before this change stored the whole ffmpeg command and output as the error. Show a
 * short reason instead (the detail is in the server log).
 */
export function readablePublishError(error: string | null) {
  if (!error) return null;
  if (error.length > 400 || /^Command failed:|ffmpeg version|\n/.test(error)) {
    return "The last publish failed while compiling the video (technical details are in the server log). Publish again.";
  }
  return error;
}

export type LoopState = ReturnType<typeof loopStateOf>;

async function statesFor(where: Prisma.LoopWhereInput, options: { skip?: number; take?: number } = {}) {
  const [rows, world, settings] = await Promise.all([
    prisma.loop.findMany({ where, orderBy: { updatedAt: "desc" }, select: listLoopSelect, ...options }),
    loadRoutingWorld(),
    getCmsSettings(),
  ]);
  const index = liveOnIndexOf(world);
  const frame = loopFrameFrom(settings);
  return rows.map((row) => loopStateOf(row, liveOnFor(index, row.id), frame));
}

export async function getLoopStates(ids: string[]) {
  await recoverInterruptedPublishes();
  return statesFor({ id: { in: ids } });
}

export async function getLoopListData({ page = 1, pageSize = 12 }: { page?: number; pageSize?: number } = {}) {
  try {
    await recoverInterruptedPublishes();
    const total = await prisma.loop.count();
    const clamped = clampPage(page, pageSize, total);
    const items = await statesFor({}, { skip: (clamped.page - 1) * pageSize, take: pageSize });
    return { items, total, page: clamped.page, pageCount: clamped.pageCount, pageSize, error: null };
  } catch (error) {
    return { items: [] as LoopState[], total: 0, page, pageCount: 1, pageSize, error: formatQueryFailure("Loop library", error) };
  }
}

const builderAssetSelect = {
  id: true,
  filename: true,
  category: true,
  status: true,
  mimeType: true,
  durationMs: true,
  width: true,
  height: true,
  fileSize: true,
  thumbnailKey: true,
  s3Key: true,
  metadata: true,
  checksum: true,
  createdAt: true,
  hiddenAt: true,
} satisfies Prisma.AssetSelect;

export async function getLoopBuilderData(loopId: string) {
  try {
    await recoverInterruptedPublishes(loopId);
    const [loop, assets, settings, deviceGroups, states] = await Promise.all([
      prisma.loop.findUnique({
        where: { id: loopId },
        include: {
          targetGroup: { select: { id: true, name: true } },
          slots: {
            orderBy: { position: "asc" },
            include: {
              staticCreative: { select: builderAssetSelect },
              contents: { orderBy: { orderInSlot: "asc" }, include: { asset: { select: builderAssetSelect } } },
            },
          },
        },
      }),
      prisma.asset.findMany({
        where: {
          status: "READY",
          hiddenAt: null,
          category: { in: ["ADVERTISEMENT", "STATIC_CREATIVE", "FILLER_WEATHER", "FILLER_NEWS", "FILLER_BRANDED", "FILLER_OTHER"] },
        },
        orderBy: { createdAt: "desc" },
        select: builderAssetSelect,
      }),
      getCmsSettings(),
      prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      statesFor({ id: loopId }),
    ]);
    return {
      loop,
      state: states[0] ?? null,
      advertisementAssets: assets.filter((asset) => asset.category === "ADVERTISEMENT"),
      staticCreativeAssets: assets.filter((asset) => asset.category === "STATIC_CREATIVE"),
      fillerAssets: assets.filter((asset) => asset.category.startsWith("FILLER_")),
      deviceGroups,
      settings,
      error: null,
    };
  } catch (error) {
    return {
      loop: null,
      state: null,
      advertisementAssets: [],
      staticCreativeAssets: [],
      fillerAssets: [],
      deviceGroups: [],
      settings: await getCmsSettings().catch(() => null),
      error: formatQueryFailure("Loop builder", error),
    };
  }
}

const libraryAssetSelect = {
  ...builderAssetSelect,
  errorMessage: true,
  slotPlacements: { select: { slot: { select: { position: true, loop: { select: { id: true, name: true, status: true } } } } } },
  staticSlots: { select: { position: true, loop: { select: { id: true, name: true, status: true } } } },
} satisfies Prisma.AssetSelect;

export type AssetLibraryItem = Prisma.AssetGetPayload<{ select: typeof libraryAssetSelect }>;

export async function getAssetLibraryData({
  page = 1,
  pageSize = 18,
  search,
  category,
}: {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: AssetCategory | "ALL";
} = {}) {
  try {
    const where: Prisma.AssetWhereInput = {
      hiddenAt: null,
      ...(category && category !== "ALL" ? { category } : {}),
      ...(search
        ? {
            OR: [
              { filename: { contains: search, mode: "insensitive" as const } },
              { metadata: { path: ["advertiserName"], string_contains: search } },
              { metadata: { path: ["campaignName"], string_contains: search } },
            ],
          }
        : {}),
    };
    await failInterruptedAssetProcessing().catch(() => undefined);
    const [total, settings] = await Promise.all([prisma.asset.count({ where }), getCmsSettings()]);
    const clamped = clampPage(page, pageSize, total);
    const items = await prisma.asset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (clamped.page - 1) * pageSize,
      take: pageSize,
      select: libraryAssetSelect,
    });
    return {
      items,
      total,
      page: clamped.page,
      pageCount: clamped.pageCount,
      pageSize,
      search: search ?? "",
      category: category ?? "ALL",
      safetyVideoAssetId: settings.safetyVideoAssetId,
      error: null,
    };
  } catch (error) {
    return {
      items: [] as AssetLibraryItem[],
      total: 0,
      page,
      pageCount: 1,
      pageSize,
      search: search ?? "",
      category: category ?? "ALL",
      safetyVideoAssetId: null,
      error: formatQueryFailure("Asset library", error),
    };
  }
}

export async function getSettingsData() {
  try {
    const [settings, users, safetyAssets] = await Promise.all([
      getCmsSettings(),
      prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.asset.findMany({
        where: { category: "SAFETY_MESSAGE", status: "READY", hiddenAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true, filename: true, durationMs: true, mimeType: true },
      }),
    ]);
    return { settings, users, safetyAssets, error: null };
  } catch (error) {
    return { settings: await getCmsSettings().catch(() => null), users: [], safetyAssets: [], error: formatQueryFailure("Settings", error) };
  }
}
