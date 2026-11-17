// Data for the desktop dashboard, cabs (devices) and analytics pages.
//
// Rules (audit P1/P2/A1-A5):
// - List pages read the latest cab state from the Device row (kept current by the heartbeat
//   route), never from the DeviceHeartbeat table.
// - Playback figures are aggregated in SQL per London calendar day; nothing pulls playback rows
//   into Node. What each figure counts is defined in lib/playback-metrics.ts.
// - "Right now" figures (on a journey, muted) only count cabs that are online.

import { prisma, Prisma } from "@orison/db";

import { getCmsSettings } from "./cms-settings";
import {
  hasPassengerDetection,
  isDeviceOnline,
  offlineThresholdMs,
  resolveDesktopDeviceStatus,
  summarizeSync,
} from "./device-status";
import { getFleetControlState } from "./fleet-control";
import { addDaysToKey, dayKeysBetween, londonDayStart, londonPeriods } from "./london-time";
import {
  getLoopRoutingSnapshot,
  resolveDeviceLoop,
  resolveFleetLoop,
  resolveGroupLevel,
  resolveGroupLoop,
  type ExpectedSource,
} from "./loop-routing";
import {
  completionPercent,
  londonDaySql,
  PLAYBACK_KIND_SQL,
  summarizePlayback,
  type DailyKindRow,
  type PlaybackKind,
} from "./playback-metrics";
import { getConfiguredSafetyMessage } from "./safety-message";
import { getPublicUrl } from "./storage";

const CHART_DAYS = 30;

function formatQueryFailure(scope: string, error: unknown) {
  console.error(error);
  return `${scope} could not be loaded. Check the server logs and refresh.`;
}

/** Desktop device status (inactive | offline | outdated | online); see lib/device-status.ts. */
export function resolveDeviceStatus(
  device: { isActive: boolean; lastHeartbeatAt: Date | null; currentLoopId: string | null },
  expectedLoopId: string | null,
  thresholdMs: number,
) {
  return resolveDesktopDeviceStatus(device, expectedLoopId, thresholdMs);
}

/** Cab fields every list needs; all on the Device row. */
const cabSelect = {
  id: true,
  serialNumber: true,
  cabLicenseNumber: true,
  driverName: true,
  hpTaxiCabId: true,
  notes: true,
  groupId: true,
  group: { select: { id: true, name: true } },
  isActive: true,
  isDisabled: true,
  disabledReason: true,
  overrideLoopId: true,
  currentLoopId: true,
  lastHeartbeatAt: true,
  lastSyncAt: true,
  firmwareVersion: true,
  storageFreeMb: true,
  playerStatus: true,
  playbackTrigger: true,
  signalPercent: true,
  signalDbm: true,
  networkType: true,
  uptimeSeconds: true,
  statusReportedAt: true,
  syncState: true,
  syncError: true,
  syncFailedLoopId: true,
  syncStateSince: true,
  syncNextRetryAt: true,
  locationLat: true,
  locationLng: true,
  locationAccuracyM: true,
  locationSource: true,
  locationAt: true,
} satisfies Prisma.DeviceSelect;

type CabRow = Prisma.DeviceGetPayload<{ select: typeof cabSelect }>;

const sourceLabels: Record<ExpectedSource, string> = {
  cab: "chosen for this cab",
  group: "from its group",
  fleet: "all cabs",
};

async function loopNames(ids: Array<string | null>) {
  const wanted = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (wanted.length === 0) {
    return new Map<string, string>();
  }
  const loops = await prisma.loop.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(loops.map((loop) => [loop.id, loop.name]));
}

function describeCabs(
  cabs: CabRow[],
  routing: Awaited<ReturnType<typeof getLoopRoutingSnapshot>>,
  names: Map<string, string>,
  thresholdMs: number,
  now: Date,
) {
  return cabs.map((cab) => {
    const expected = resolveDeviceLoop(cab, routing);
    const online = cab.isActive && isDeviceOnline(cab.lastHeartbeatAt, thresholdMs, now);
    return {
      ...cab,
      online,
      status: resolveDesktopDeviceStatus(cab, expected.loop?.id ?? null, thresholdMs, now),
      expectedLoopId: expected.loop?.id ?? null,
      expectedLoopName: expected.loop?.name ?? null,
      expectedSource: expected.source,
      expectedSourceLabel: expected.source ? sourceLabels[expected.source] : null,
      currentLoopName: cab.currentLoopId ? names.get(cab.currentLoopId) ?? null : null,
      sync: summarizeSync(cab, expected.loop?.id ?? null),
      detectsPassengers: hasPassengerDetection(cab.playbackTrigger),
      // Only an online cab's player state describes "now".
      playerStatusNow: online ? cab.playerStatus ?? "unknown" : null,
    };
  });
}

type AggregateRow = {
  day: Date;
  kind: PlaybackKind;
  assetId: string | null;
  plays: number;
  measured: number;
  measuredCompleted: number;
  durationMsSum: number;
  journeyModePlays: number;
};

/** One pass over PlaybackLog since `from`: counts per London day and kind (adverts per asset). */
async function playbackAggregates(from: Date) {
  // JIT compiling this one-off query costs more than it saves (measured: ~0.6 s of 1.3 s on a
  // year of data for 50 cabs), so it is switched off for this transaction only.
  const [, rows] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL jit = off`,
    prisma.$queryRaw<AggregateRow[]>`
    SELECT day, kind, CASE WHEN kind = 'advert' THEN "assetId" END AS "assetId",
           count(*)::int AS plays,
           count(*) FILTER (WHERE "eventId" IS NOT NULL)::int AS measured,
           count(*) FILTER (WHERE "eventId" IS NOT NULL AND "completedFull")::int AS "measuredCompleted",
           coalesce(sum("durationMs"), 0)::float8 AS "durationMsSum",
           count(*) FILTER (WHERE mode = 'journey')::int AS "journeyModePlays"
    FROM (
      SELECT ${Prisma.raw(londonDaySql())} AS day,
             ${Prisma.raw(PLAYBACK_KIND_SQL)} AS kind,
             "eventId", "completedFull", "durationMs", mode, "assetId"
      FROM "PlaybackLog"
      WHERE "playedAt" >= ${from}
    ) rows
    WHERE kind <> 'other'
    GROUP BY 1, 2, 3
  `,
  ]);
  return rows;
}

function dayKeyOf(value: Date) {
  return value.toISOString().slice(0, 10);
}

async function loadPlaybackSummary(now: Date) {
  const periods = londonPeriods(now);
  const seriesKeys = dayKeysBetween(addDaysToKey(periods.todayKey, -(CHART_DAYS - 1)), periods.todayKey);
  // "This month" can start before the 30-day chart.
  const firstKey = periods.monthStartKey < seriesKeys[0] ? periods.monthStartKey : seriesKeys[0];
  const rows = await playbackAggregates(londonDayStart(firstKey));

  const daily = new Map<string, DailyKindRow>();
  const perAdvert = new Map<string, { plays: number; measured: number; completed: number }>();
  for (const row of rows) {
    const day = dayKeyOf(row.day);
    const key = `${day}|${row.kind}`;
    const current =
      daily.get(key) ??
      { day, kind: row.kind, plays: 0, measured: 0, measuredCompleted: 0, durationMsSum: 0, journeyModePlays: 0 };
    current.plays += row.plays;
    current.measured += row.measured;
    current.measuredCompleted += row.measuredCompleted;
    current.durationMsSum += Number(row.durationMsSum);
    current.journeyModePlays += row.journeyModePlays;
    daily.set(key, current);
    if (row.kind === "advert" && row.assetId && day >= seriesKeys[0]) {
      const totals = perAdvert.get(row.assetId) ?? { plays: 0, measured: 0, completed: 0 };
      totals.plays += row.plays;
      totals.measured += row.measured;
      totals.completed += row.measuredCompleted;
      perAdvert.set(row.assetId, totals);
    }
  }

  const summary = summarizePlayback(Array.from(daily.values()), { ...periods, seriesKeys });
  return { periods, seriesKeys, summary, perAdvert };
}

function journeysApplicable(cabs: Array<{ isActive: boolean; playbackTrigger: string | null }>) {
  const active = cabs.filter((cab) => cab.isActive);
  // With no cabs at all there is nothing to say either way; journeys are the normal case.
  return active.length === 0 || active.some((cab) => hasPassengerDetection(cab.playbackTrigger));
}

export async function getDashboardData() {
  try {
    const now = new Date();
    const [routing, fleetControl, settings, cabRows, groups, activity, publishingLoops, playback] =
      await Promise.all([
        getLoopRoutingSnapshot(),
        getFleetControlState(),
        getCmsSettings(),
        prisma.device.findMany({ orderBy: { serialNumber: "asc" }, select: cabSelect }),
        prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }),
        prisma.activityEvent.findMany({ orderBy: { createdAt: "desc" }, take: 14 }),
        prisma.loop.findMany({
          where: { status: "PUBLISHING" },
          orderBy: { updatedAt: "desc" },
          take: 4,
          select: { id: true, name: true, updatedAt: true, targetGroup: { select: { id: true, name: true } } },
        }),
        loadPlaybackSummary(now),
      ]);

    const safetyVideo = await getConfiguredSafetyMessage(settings);
    const safetyAsset = safetyVideo
      ? await prisma.asset.findUnique({ where: { id: safetyVideo.assetId }, select: { filename: true } })
      : null;

    const thresholdMs = offlineThresholdMs(settings.heartbeatIntervalSeconds);
    const names = await loopNames(cabRows.map((cab) => cab.currentLoopId));
    const cabs = describeCabs(cabRows, routing, names, thresholdMs, now);
    const fleetWideLoop = resolveFleetLoop(routing);

    const count = (predicate: (cab: (typeof cabs)[number]) => boolean) => cabs.filter(predicate).length;
    const onlineNow = (status: string) => (cab: (typeof cabs)[number]) => cab.playerStatusNow === status;

    const groupSummaries = [
      {
        id: "fleet-all",
        name: "All cabs",
        description: null as string | null,
        cabCount: cabs.length,
        onlineCount: count((cab) => cab.status === "online"),
        outdatedCount: count((cab) => cab.status === "outdated"),
        offlineCount: count((cab) => cab.status === "offline"),
        loop: fleetWideLoop,
        href: "/devices",
      },
      ...groups.map((group) => {
        const members = cabs.filter((cab) => cab.groupId === group.id);
        return {
          id: group.id,
          name: group.name,
          description: group.description,
          cabCount: members.length,
          onlineCount: members.filter((cab) => cab.status === "online").length,
          outdatedCount: members.filter((cab) => cab.status === "outdated").length,
          offlineCount: members.filter((cab) => cab.status === "offline").length,
          loop: resolveGroupLoop(group.id, routing).loop,
          href: `/devices?group=${group.id}`,
        };
      }),
    ];

    const liveLoops = [
      ...(fleetWideLoop
        ? [{ id: fleetWideLoop.id, name: fleetWideLoop.name, audience: "All cabs", publishedAt: fleetWideLoop.publishedAt, isFleet: true }]
        : []),
      ...groups.flatMap((group) => {
        const loop = resolveGroupLevel(group.id, routing).loop;
        return loop ? [{ id: loop.id, name: loop.name, audience: group.name, publishedAt: loop.publishedAt, isFleet: false }] : [];
      }),
      ...cabs
        .filter((cab) => cab.expectedSource === "cab" && cab.expectedLoopId)
        .map((cab) => ({
          id: cab.expectedLoopId!,
          name: cab.expectedLoopName ?? "Loop",
          audience: `Cab ${cab.serialNumber} only`,
          publishedAt: null as Date | null,
          isFleet: false,
        })),
    ];

    const attentionItems: Array<{
      id: string;
      severity: "critical" | "warning" | "info";
      title: string;
      detail: string;
      href: string;
      actionLabel: string;
    }> = [];

    if (fleetControl.disabled) {
      attentionItems.push({
        id: "fleet-paused",
        severity: "critical",
        title: "All cabs are paused",
        detail: fleetControl.reason ?? "No reason given.",
        href: "/devices",
        actionLabel: "Open cabs",
      });
    }
    if (!safetyVideo) {
      attentionItems.push({
        id: "missing-safety",
        severity: "warning",
        title: "No safety message is set",
        detail: "Journeys start without a safety message until one is chosen in Settings.",
        href: "/settings",
        actionLabel: "Open settings",
      });
    }
    if (liveLoops.length === 0) {
      attentionItems.push({
        id: "no-live-loops",
        severity: "warning",
        title: "No loop is live",
        detail: "Publish a loop for all cabs or a group so cabs have something to play.",
        href: "/loops",
        actionLabel: "Open loops",
      });
    }
    for (const loop of publishingLoops) {
      attentionItems.push({
        id: `publishing-${loop.id}`,
        severity: "info",
        title: `${loop.name} is being published`,
        detail: `Compiling for ${loop.targetGroup?.name ?? "all cabs"}.`,
        href: `/loops/${loop.id}`,
        actionLabel: "Open loop",
      });
    }
    for (const cab of cabs.filter((item) => item.isActive && item.sync.state === "failing").slice(0, 3)) {
      attentionItems.push({
        id: `sync-${cab.id}`,
        severity: "critical",
        title: `Cab ${cab.serialNumber} cannot update`,
        detail: cab.sync.error ?? "Its last update attempt failed.",
        href: "/devices",
        actionLabel: "Open cabs",
      });
    }
    for (const cab of cabs.filter((item) => item.status === "offline").slice(0, 3)) {
      attentionItems.push({
        id: `offline-${cab.id}`,
        severity: "warning",
        title: `Cab ${cab.serialNumber} is offline`,
        detail: cab.lastHeartbeatAt ? "No heartbeat recently." : "It has never sent a heartbeat.",
        href: "/devices",
        actionLabel: "Open cabs",
      });
    }
    for (const cab of cabs.filter((item) => item.status === "outdated" && item.sync.state !== "failing").slice(0, 3)) {
      attentionItems.push({
        id: `outdated-${cab.id}`,
        severity: "info",
        title: `Cab ${cab.serialNumber} is not on its loop yet`,
        detail: `It should play ${cab.expectedLoopName ?? "a published loop"} but plays ${cab.currentLoopName ?? cab.currentLoopId ?? "nothing"}.`,
        href: "/devices",
        actionLabel: "Open cabs",
      });
    }
    const lowStorage = cabs.find((cab) => typeof cab.storageFreeMb === "number" && cab.storageFreeMb < 1024);
    if (lowStorage) {
      attentionItems.push({
        id: `storage-${lowStorage.id}`,
        severity: "warning",
        title: `Cab ${lowStorage.serialNumber} is low on storage`,
        detail: `${lowStorage.storageFreeMb} MB free.`,
        href: "/devices",
        actionLabel: "Open cabs",
      });
    }

    const { summary } = playback;
    const passengerDetection = journeysApplicable(cabs);
    return {
      cabs,
      fleetWideLoop,
      safetyVideo: safetyVideo ? { ...safetyVideo, filename: safetyAsset?.filename ?? "Safety message" } : null,
      fleetControl,
      activity,
      liveLoops,
      publishingLoops,
      attentionItems: attentionItems.slice(0, 8),
      groupSummaries,
      passengerDetection,
      stats: {
        totalCabs: cabs.length,
        onlineCount: count((cab) => cab.status === "online"),
        outdatedCount: count((cab) => cab.status === "outdated"),
        offlineCount: count((cab) => cab.status === "offline"),
        pausedCount: count((cab) => cab.isDisabled),
        syncFailingCount: count((cab) => cab.isActive && cab.sync.state === "failing"),
        onJourneyNow: count(onlineNow("playing")) + count(onlineNow("silent")),
        mutedNow: count(onlineNow("silent")),
        idleNow: count(onlineNow("idle")),
        advertPlaysToday: summary.totals.advertPlaysToday,
        stillShowingsToday: summary.totals.stillShowingsToday,
      },
      journeyMetrics: summary.journeys,
      error: null,
    };
  } catch (error) {
    return {
      cabs: [] as ReturnType<typeof describeCabs>,
      fleetWideLoop: null,
      safetyVideo: null,
      fleetControl: { disabled: false, reason: null },
      activity: [],
      liveLoops: [],
      publishingLoops: [],
      attentionItems: [],
      groupSummaries: [],
      passengerDetection: true,
      stats: {
        totalCabs: 0,
        onlineCount: 0,
        outdatedCount: 0,
        offlineCount: 0,
        pausedCount: 0,
        syncFailingCount: 0,
        onJourneyNow: 0,
        mutedNow: 0,
        idleNow: 0,
        advertPlaysToday: 0,
        stillShowingsToday: 0,
      },
      journeyMetrics: { today: 0, week: 0, month: 0, averageDurationMs: null, advertPlaysPerJourney: null },
      error: formatQueryFailure("Dashboard data", error),
    };
  }
}

export async function getDevicesData({
  page = 1,
  pageSize = 12,
  groupId,
}: {
  page?: number;
  pageSize?: number;
  groupId?: string | null;
} = {}) {
  try {
    const now = new Date();
    const filterGroupId = groupId && groupId !== "ALL" ? groupId : null;
    const where = filterGroupId ? { groupId: filterGroupId } : undefined;
    const [routing, groups, cabRows, total, fleetControl, settings] = await Promise.all([
      getLoopRoutingSnapshot(),
      prisma.deviceGroup.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, description: true, _count: { select: { devices: true } } },
      }),
      prisma.device.findMany({
        where,
        orderBy: { serialNumber: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: cabSelect,
      }),
      prisma.device.count({ where }),
      getFleetControlState(),
      getCmsSettings(),
    ]);
    const thresholdMs = offlineThresholdMs(settings.heartbeatIntervalSeconds);
    const names = await loopNames(cabRows.flatMap((cab) => [cab.currentLoopId, cab.syncFailedLoopId]));
    // cabSelect never includes apiTokenHash.
    const cabs = describeCabs(cabRows, routing, names, thresholdMs, now).map((cab) => ({
      ...cab,
      syncFailedLoopName: cab.syncFailedLoopId ? names.get(cab.syncFailedLoopId) ?? null : null,
    }));

    return {
      cabs,
      groups,
      total,
      page,
      pageSize,
      selectedGroupId: filterGroupId ?? "ALL",
      fleetControl,
      error: null,
    };
  } catch (error) {
    return {
      cabs: [],
      groups: [],
      total: 0,
      page,
      pageSize,
      selectedGroupId: groupId ?? "ALL",
      fleetControl: { disabled: false, reason: null },
      error: formatQueryFailure("Cab list", error),
    };
  }
}

export async function getAnalyticsData() {
  try {
    const now = new Date();
    const [settings, cabs, playback] = await Promise.all([
      getCmsSettings(),
      prisma.device.findMany({
        where: { isActive: true },
        orderBy: { serialNumber: "asc" },
        select: {
          serialNumber: true,
          lastHeartbeatAt: true,
          playbackTrigger: true,
          isActive: true,
          locationLat: true,
          locationLng: true,
          locationAccuracyM: true,
          locationSource: true,
          locationAt: true,
        },
      }),
      loadPlaybackSummary(now),
    ]);
    const thresholdMs = offlineThresholdMs(settings.heartbeatIntervalSeconds);
    const onlineNow = cabs.filter((cab) => isDeviceOnline(cab.lastHeartbeatAt, thresholdMs, now)).length;

    const assetIds = Array.from(playback.perAdvert.keys());
    const assets = assetIds.length
      ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, filename: true } })
      : [];
    const assetNames = new Map(assets.map((asset) => [asset.id, asset.filename]));

    const { summary, periods, seriesKeys } = playback;
    return {
      todayKey: periods.todayKey,
      firstDayKey: seriesKeys[0],
      series: summary.series,
      totals: summary.totals,
      completion: summary.completion,
      busiestDay: summary.busiestDay,
      adBreakdown: Array.from(playback.perAdvert.entries())
        .map(([assetId, totals]) => ({
          assetId,
          label: assetNames.get(assetId) ?? assetId,
          plays: totals.plays,
          measuredPlays: totals.measured,
          completionPercent: completionPercent(totals.measured, totals.completed),
        }))
        .sort((left, right) => right.plays - left.plays),
      onlineNow,
      activeCabs: cabs.length,
      passengerDetection: journeysApplicable(cabs),
      journeyMetrics: summary.journeys,
      cabLocations: cabs.map((cab) => ({
        serialNumber: cab.serialNumber,
        lastHeartbeatAt: cab.lastHeartbeatAt?.toISOString() ?? null,
        location:
          cab.locationLat != null && cab.locationLng != null
            ? {
                lat: cab.locationLat,
                lng: cab.locationLng,
                accuracyM: cab.locationAccuracyM,
                source: cab.locationSource,
                at: cab.locationAt?.toISOString() ?? null,
              }
            : null,
      })),
      error: null,
    };
  } catch (error) {
    return {
      todayKey: null,
      firstDayKey: null,
      series: [],
      totals: { advertPlays: 0, advertPlaysToday: 0, stillShowings: 0, stillShowingsToday: 0, fillerPlays: 0, safetyPlays: 0 },
      completion: { measuredPlays: 0, completedPlays: 0, ratePercent: null },
      busiestDay: null,
      adBreakdown: [],
      onlineNow: 0,
      activeCabs: 0,
      passengerDetection: true,
      journeyMetrics: { today: 0, week: 0, month: 0, averageDurationMs: null, advertPlaysPerJourney: null },
      cabLocations: [],
      error: formatQueryFailure("Analytics", error),
    };
  }
}

/**
 * The loop the fleet is set to play (cabs that follow "all cabs"), resolved with the same rules as
 * the device manifest route, with the safety message configured now. Feeds the public
 * /device-preview page, so it must never return a loop that is merely in the library.
 */
export async function getCurrentPublishedLoop() {
  try {
    const fleetLoop = resolveFleetLoop(await getLoopRoutingSnapshot());
    const loop = fleetLoop
      ? await prisma.loop.findFirst({
          where: {
            id: fleetLoop.id,
            status: "PUBLISHED",
            OR: [{ compiledVideoUrl: { not: null } }, { compiledVideoKey: { not: null } }],
          },
          select: { id: true, name: true, compiledVideoUrl: true, compiledVideoKey: true },
        })
      : null;
    if (!loop) {
      return null;
    }
    const safety = await getConfiguredSafetyMessage();
    return {
      ...loop,
      compiledVideoUrl: loop.compiledVideoKey ? getPublicUrl(loop.compiledVideoKey) : loop.compiledVideoUrl,
      safetyVideo: safety ? { url: safety.url, durationMs: safety.durationMs, mimeType: safety.mimeType } : null,
    };
  } catch (error) {
    console.error(error);
    return null;
  }
}
