// Server-side data assembly for the mobile JSON API (/api/m/*). The client mirror of these shapes
// is src/mobile/lib/types.ts; keep the two in step.

import { prisma, type Prisma } from "@orison/db";

import { getCmsSettings } from "./cms-settings";
import {
  coveredSeconds,
  detectedNetworkType,
  heartbeatIntervals,
  isJourneyStatus,
  JOURNEY_EVIDENCE_DAYS,
  reportsJourneys,
  isDeviceOnline,
  offlineThresholdMs,
  resolveMobileDeviceStatus,
  startOfLocalDay,
  summarizeSync,
  type MobileCabStatus,
} from "./device-status";
import { getFleetControlState } from "./fleet-control";
import { ApiError } from "./http";
import {
  getLoopRoutingSnapshot,
  resolveDeviceLoop,
  resolveFleetLoop,
  resolveGroupLevel,
  resolveGroupLoop,
  type ExpectedSource,
  type LoopRoutingSnapshot,
} from "./loop-routing";
import { changeLagMinutesFor, summarizeChangeLag } from "./change-lag";
import { uploadJobState, uploadsAhead } from "./upload-queue";
import { isProcessingStale, STALE_PUBLISHING_MESSAGE, STALE_TARGET_STEP_MESSAGE } from "./upload-rules";

export const LONDON_TZ = "Europe/London";

// ---------------------------------------------------------------------------------------------
// Loops

export const loopSummarySelect = {
  id: true,
  name: true,
  status: true,
  publishError: true,
  durationMs: true,
  compiledVideoKey: true,
  posterKey: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  autoLive: true,
  pendingTargetAt: true,
  _count: { select: { slots: true } },
} satisfies Prisma.LoopSelect;

type LoopRow = Prisma.LoopGetPayload<{ select: typeof loopSummarySelect }>;

export type LoopProcessing = {
  state: "processing" | "ready" | "failed";
  error: string | null;
  /** Additive: true while a phone upload is queued behind another one (state "processing"). */
  waiting: boolean;
  /** Additive: uploads queued ahead of this one (0 unless waiting). */
  queuedBehind: number;
};

export type LoopSummary = {
  id: string;
  name: string;
  status: "DRAFT" | "REVIEW" | "PUBLISHING" | "PUBLISHED" | "ARCHIVED";
  processing: LoopProcessing;
  durationMs: number | null;
  posterUrl: string | null;
  videoUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  source: "upload" | "builder";
  liveOn: {
    fleet: boolean;
    groups: { id: string; name: string }[];
    cabCount: number;
    /**
     * Additive: active cabs that last reported playing it, whatever they are set to. A cab whose
     * download keeps failing still shows its old video, so "not playing anywhere" would be false.
     */
    onScreens: number;
  };
};

/**
 * Processing state of a loop as the phone sees it. A phone upload is "processing" while it waits
 * in the queue, is being prepared, or is published but its requested target is still being
 * applied (so the phone never says "on its way" before the outcome is known). The server touches
 * the row every minute while it works on it; a row left untouched for STALE_PUBLISHING_MS is no
 * longer being worked on and is reported as failed (or, after a publish, as ready with a note).
 */
export function loopProcessing(
  loop: Pick<LoopRow, "id" | "status" | "publishError" | "updatedAt"> & { pendingTargetAt?: Date | null },
  now = new Date(),
  job: { state: "waiting" | "running" | null; ahead: number } = { state: null, ahead: 0 },
): LoopProcessing {
  const base = { waiting: false, queuedBehind: 0 };
  const working = job.state !== null || !isProcessingStale(loop.updatedAt, now);
  if (loop.status === "PUBLISHING") {
    if (!working) {
      return { ...base, state: "failed", error: STALE_PUBLISHING_MESSAGE };
    }
    return {
      state: "processing",
      error: null,
      waiting: job.state === "waiting",
      queuedBehind: job.state === "waiting" ? job.ahead : 0,
    };
  }
  if (loop.status === "PUBLISHED") {
    if (loop.pendingTargetAt) {
      return working
        ? { ...base, state: "processing", error: null }
        : { ...base, state: "ready", error: STALE_TARGET_STEP_MESSAGE };
    }
    // A publish that succeeded but whose requested target was not applied keeps a note.
    return { ...base, state: "ready", error: loop.publishError ?? null };
  }
  if (loop.publishError) {
    return { ...base, state: "failed", error: loop.publishError };
  }
  return { ...base, state: "ready", error: null };
}

export function posterUrlFor(loop: { id: string; compiledVideoKey: string | null } | null | undefined) {
  return loop?.compiledVideoKey ? `/api/m/loops/${loop.id}/poster` : null;
}

export function videoUrlFor(loop: { compiledVideoKey: string | null }) {
  // Same-origin; local storage streams with Range support, S3 redirects to a signed URL.
  return loop.compiledVideoKey ? `/api/storage/${loop.compiledVideoKey}` : null;
}

type ActiveDeviceForRouting = { id: string; groupId: string | null; overrideLoopId: string | null; currentLoopId?: string | null };

export type LiveOnIndex = {
  fleetLoopId: string | null;
  groupsByLoop: Map<string, { id: string; name: string }[]>;
  cabCountByLoop: Map<string, number>;
  onScreensByLoop?: Map<string, number>;
};

/**
 * Where each loop is effectively live. `groups` lists groups whose own group-level resolution
 * picks the loop (groups that merely follow the fleet are not listed; `fleet: true` covers them).
 * `cabCount` counts active cabs whose resolved expected loop is this loop (overrides included).
 */
export function buildLiveOnIndex(
  snapshot: LoopRoutingSnapshot,
  groups: Array<{ id: string; name: string }>,
  devices: ActiveDeviceForRouting[],
): LiveOnIndex {
  const fleetLoopId = resolveFleetLoop(snapshot)?.id ?? null;
  const groupsByLoop = new Map<string, { id: string; name: string }[]>();
  for (const group of groups) {
    const level = resolveGroupLevel(group.id, snapshot);
    if (level.loop) {
      const list = groupsByLoop.get(level.loop.id) ?? [];
      list.push({ id: group.id, name: group.name });
      groupsByLoop.set(level.loop.id, list);
    }
  }
  const cabCountByLoop = new Map<string, number>();
  const onScreensByLoop = new Map<string, number>();
  for (const device of devices) {
    const loopId = resolveDeviceLoop(device, snapshot).loop?.id;
    if (loopId) {
      cabCountByLoop.set(loopId, (cabCountByLoop.get(loopId) ?? 0) + 1);
    }
    if (device.currentLoopId) {
      onScreensByLoop.set(device.currentLoopId, (onScreensByLoop.get(device.currentLoopId) ?? 0) + 1);
    }
  }
  return { fleetLoopId, groupsByLoop, cabCountByLoop, onScreensByLoop };
}

/** Shown instead of a desktop publish error, whose text can carry internal detail (paths, tools). */
export const DESKTOP_PUBLISH_ERROR_MESSAGE =
  "The last publish of this loop on the desktop site failed. Open it on the desktop site for details.";

/**
 * Processing state as the phone API returns it. Errors of phone uploads are written for the phone
 * (fixed, user-facing messages); a loop built on the desktop site (autoLive) can carry the raw text
 * of a failed publish, which is not shown to the phone app (it is open to anyone by default).
 */
export function phoneLoopProcessing(processing: LoopProcessing, loop: { autoLive: boolean }): LoopProcessing {
  if (processing.error && loop.autoLive) {
    return { ...processing, error: DESKTOP_PUBLISH_ERROR_MESSAGE };
  }
  return processing;
}

export function toLoopSummary(loop: LoopRow, liveOn: LiveOnIndex, now = new Date()): LoopSummary {
  return {
    id: loop.id,
    name: loop.name,
    status: loop.status,
    processing: phoneLoopProcessing(
      loopProcessing(loop, now, { state: uploadJobState(loop.id), ahead: uploadsAhead(loop.id) }),
      loop,
    ),
    durationMs: loop.durationMs ?? (loop._count.slots > 0 && loop.compiledVideoKey ? 600_000 : null),
    posterUrl: posterUrlFor(loop),
    videoUrl: videoUrlFor(loop),
    publishedAt: loop.publishedAt?.toISOString() ?? null,
    createdAt: loop.createdAt.toISOString(),
    source: loop._count.slots > 0 ? "builder" : "upload",
    liveOn: {
      fleet: liveOn.fleetLoopId === loop.id,
      groups: liveOn.groupsByLoop.get(loop.id) ?? [],
      cabCount: liveOn.cabCountByLoop.get(loop.id) ?? 0,
      onScreens: liveOn.onScreensByLoop?.get(loop.id) ?? 0,
    },
  };
}

async function loadRoutingContext() {
  const [snapshot, groups, devices] = await Promise.all([
    getLoopRoutingSnapshot(),
    prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.device.findMany({
      where: { isActive: true },
      select: { id: true, groupId: true, overrideLoopId: true, currentLoopId: true },
    }),
  ]);
  return { snapshot, groups, devices, liveOn: buildLiveOnIndex(snapshot, groups, devices) };
}

/** PUBLISHED loops plus phone uploads that are processing or failed (never ARCHIVED). */
export async function listMobileLoops() {
  const [rows, context] = await Promise.all([
    prisma.loop.findMany({
      where: {
        OR: [
          { status: "PUBLISHED" },
          { autoLive: false, status: "PUBLISHING" },
          { autoLive: false, status: "DRAFT", publishError: { not: null } },
        ],
      },
      select: loopSummarySelect,
    }),
    loadRoutingContext(),
  ]);
  const now = new Date();
  return rows
    .sort(
      (a, b) =>
        (b.publishedAt ?? b.createdAt).getTime() - (a.publishedAt ?? a.createdAt).getTime(),
    )
    .map((row) => toLoopSummary(row, context.liveOn, now));
}

const NOT_LIVE: LiveOnIndex = { fleetLoopId: null, groupsByLoop: new Map(), cabCountByLoop: new Map() };

/**
 * One loop. Where it plays (liveOn) needs the whole routing context, so it is only worked out for a
 * PUBLISHED loop: a video that is still being prepared, failed or archived can't be on any cab, and
 * the phone polls those while it waits.
 */
export async function getMobileLoop(loopId: string) {
  const row = await prisma.loop.findUnique({ where: { id: loopId }, select: loopSummarySelect });
  if (!row) {
    throw new ApiError("Loop not found", 404);
  }
  if (row.status !== "PUBLISHED" || row.pendingTargetAt) {
    const summary = toLoopSummary(row, NOT_LIVE);
    if (summary.processing.state !== "ready" || row.status !== "PUBLISHED") return summary;
  }
  const context = await loadRoutingContext();
  return toLoopSummary(row, context.liveOn);
}

export async function archiveMobileLoop(loopId: string) {
  const [row, context] = await Promise.all([
    prisma.loop.findUnique({ where: { id: loopId }, select: loopSummarySelect }),
    loadRoutingContext(),
  ]);
  if (!row) {
    throw new ApiError("Loop not found", 404);
  }
  if (row.status === "ARCHIVED") {
    return row;
  }
  const summary = toLoopSummary(row, context.liveOn);
  if (summary.processing.state === "processing") {
    throw new ApiError("This video is still processing. Wait for it to finish before archiving it.", 409);
  }
  if (summary.liveOn.fleet || summary.liveOn.groups.length > 0 || summary.liveOn.cabCount > 0) {
    const places = [
      summary.liveOn.fleet ? "all cabs" : null,
      ...summary.liveOn.groups.map((group) => `group ${group.name}`),
      !summary.liveOn.fleet && summary.liveOn.groups.length === 0
        ? `${summary.liveOn.cabCount} cab${summary.liveOn.cabCount === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);
    throw new ApiError(
      `"${row.name}" is live on ${places.join(", ")}. Put something else on first, then archive it.`,
      409,
      { liveOn: summary.liveOn },
    );
  }
  return prisma.loop.update({ where: { id: row.id }, data: { status: "ARCHIVED" } });
}

// ---------------------------------------------------------------------------------------------
// Cabs

export type CabLocation = { lat: number; lng: number; accuracyM: number | null; source: "gps" | "cell"; at: string };
type LoopRef = { id: string; name: string; posterUrl: string | null };

/**
 * What the cab's equipment reports about where it is, from its latest heartbeat: a GPS fix,
 * only its mobile mast (approximate), or nothing at all (no modem the box can read, e.g. the
 * NetworkManager fallback). "unknown": it has never sent a heartbeat.
 */
export type PositionReporting = "gps" | "cell" | "none" | "unknown";

/** How the cab starts playing for passengers (firmware 1.2.0 reports it; older firmware does not). */
export type PlaybackTrigger = "gpio" | "keyboard" | "always";

export type CabSummary = {
  id: string;
  serialNumber: string;
  label: string;
  driverName: string | null;
  group: { id: string; name: string } | null;
  status: MobileCabStatus;
  /** "fallback" and "error" are additive (firmware 1.2.0 reports them). */
  playerStatus: "journey" | "silent" | "idle" | "disabled" | "fallback" | "error" | "unknown";
  lastSeenAt: string | null;
  /** The library video the cab reports playing; null when it plays its built-in video (see playingBuiltIn). */
  playing: LoopRef | null;
  expected: LoopRef | null;
  expectedSource: ExpectedSource | null;
  isUpToDate: boolean;
  uptimeSeconds: number | null;
  onlineSince: string | null;
  hoursOnlineToday: number;
  /** Additive: seconds on since London midnight, unrounded (hoursOnlineToday is to a tenth of an hour). */
  secondsOnlineToday: number;
  inServiceSince: string;
  location: CabLocation | null;
  isPaused: boolean;
  pausedReason: string | null;
  /** Additive: this cab's own screen is paused (resuming it from the phone works). */
  cabPaused: boolean;
  /** Additive: every screen is paused from the desktop site (resuming one cab does nothing). */
  fleetPaused: boolean;
  /** Additive: worst-case minutes for this cab to act on a change, from its firmware version. */
  changeLagMinutes: number;
  /**
   * Additive: the cab reports its built-in standby video ("fallback"): a new box, or one that lost
   * its video. It is not a library video, so there is nothing to watch in the app.
   */
  playingBuiltIn: boolean;
  /** Additive: see PositionReporting. */
  positionReporting: PositionReporting;
  /** Additive: how journeys start, once the cab reports it (null until then). */
  playbackTrigger: PlaybackTrigger | null;
  /**
   * Additive: this cab plays for passenger journeys, so passenger wording ("Waiting for a
   * passenger") makes sense. From playbackTrigger when known; otherwise true only if the cab has
   * reported a journey (player "playing" or "silent") in the last 30 days.
   */
  reportsJourneys: boolean;
  /** Additive: fine-grained player state from firmware 1.2.0+ ("SAFETY", "JOURNEY", ...), or null. */
  playerState: string | null;
  /**
   * Additive: how the cab's content update stands (lib/device-status.ts summarizeSync).
   * "failing" (with the cab's reason and when it retries) and "downloading" come from firmware
   * 1.2.0+; "waiting" is an older cab not yet on its expected video, which can't say why.
   */
  sync: {
    state: "failing" | "downloading" | "waiting" | "current" | "unknown";
    error: string | null;
    since: string | null;
    nextRetryAt: string | null;
    lastSyncedAt: string | null;
    /** The video it failed to fetch, when the cab names it. */
    failedLoop: { id: string; name: string } | null;
  };
};

const cabDeviceSelect = {
  id: true,
  serialNumber: true,
  cabLicenseNumber: true,
  driverName: true,
  groupId: true,
  isActive: true,
  isDisabled: true,
  disabledReason: true,
  currentLoopId: true,
  overrideLoopId: true,
  lastHeartbeatAt: true,
  createdAt: true,
  locationLat: true,
  locationLng: true,
  locationAccuracyM: true,
  locationSource: true,
  locationAt: true,
  firmwareVersion: true,
  // The latest reported state, kept on the Device row by the heartbeat route (filled from the
  // newest heartbeat at server start for cabs that have not reported since). statusReportedAt null
  // = not filled yet: fall back to the newest heartbeat.
  playbackTrigger: true,
  playerStatus: true,
  playerState: true,
  signalPercent: true,
  signalDbm: true,
  uptimeSeconds: true,
  networkType: true,
  storageFreeMb: true,
  statusReportedAt: true,
  syncState: true,
  syncError: true,
  syncFailedLoopId: true,
  syncStateSince: true,
  syncNextRetryAt: true,
  lastSyncAt: true,
} satisfies Prisma.DeviceSelect;

type CabDeviceRow = Prisma.DeviceGetPayload<{ select: typeof cabDeviceSelect }>;

type LatestHeartbeat = {
  receivedAt: Date;
  uptimeSeconds: number | null;
  playerStatus: string | null;
  signalStrength: number | null;
  /** 0-100, sent separately by firmware 1.2.0+. */
  signalPercent: number | null;
  networkType: string | null;
  cpuTemp: number | null;
  storageFreeMb: number | null;
  /** locationData.method of the heartbeat: "gps", "cell_tower", "network_manager", or null. */
  locationMethod: string | null;
};

/** What the cab last reported: from the Device row, or (not filled yet) its newest heartbeat. */
type ReportedState = {
  at: Date;
  playerStatus: string | null;
  uptimeSeconds: number | null;
  networkType: string | null;
  signalPercent: number | null;
  signalDbm: number | null;
};

function reportedState(device: CabDeviceRow, latest: LatestHeartbeat | null): ReportedState | null {
  if (device.statusReportedAt) {
    return {
      at: device.statusReportedAt,
      playerStatus: device.playerStatus,
      uptimeSeconds: device.uptimeSeconds,
      networkType: device.networkType,
      signalPercent: device.signalPercent,
      signalDbm: device.signalDbm,
    };
  }
  if (!latest) return null;
  const signal = splitSignal(latest.signalStrength, latest.signalPercent);
  return {
    at: latest.receivedAt,
    playerStatus: latest.playerStatus,
    uptimeSeconds: latest.uptimeSeconds,
    networkType: latest.networkType,
    signalPercent: signal.signalPercent,
    signalDbm: signal.signalDbm,
  };
}

/**
 * Cabs whose newest heartbeat is still needed: the Device row has no reported state yet, or the
 * cab has no position (its heartbeats say whether its equipment can report one).
 */
function needsLatestHeartbeat(device: Pick<CabDeviceRow, "statusReportedAt" | "lastHeartbeatAt" | "locationAt">) {
  return Boolean(device.lastHeartbeatAt && (!device.statusReportedAt || !device.locationAt));
}

/** The currentLoopId a box reports while it plays its built-in standby video. */
export const BUILT_IN_LOOP_ID = "fallback";

export function normalizePlayerStatus(status: string | null | undefined): CabSummary["playerStatus"] {
  switch (status) {
    case "playing":
      return "journey";
    case "silent":
    case "idle":
    case "disabled":
    case "fallback":
    case "error":
      return status;
    default:
      return "unknown";
  }
}

export function positionReportingFrom(latest: Pick<LatestHeartbeat, "locationMethod"> | null): PositionReporting {
  if (!latest) return "unknown";
  if (latest.locationMethod === "gps") return "gps";
  if (latest.locationMethod === "cell_tower") return "cell";
  return "none";
}

export function parsePlaybackTrigger(value: unknown): PlaybackTrigger | null {
  return value === "gpio" || value === "keyboard" || value === "always" ? value : null;
}

// Passenger wording follows lib/device-status.ts reportsJourneys (shared with the desktop): a
// reported trigger decides; with none (firmware before 1.2.0) the cab must have reported a journey
// ("playing"/"silent", isJourneyStatus) in the last JOURNEY_EVIDENCE_DAYS.

function deviceLocation(device: CabDeviceRow): CabLocation | null {
  if (device.locationLat === null || device.locationLng === null || !device.locationAt) {
    return null;
  }
  return {
    lat: device.locationLat,
    lng: device.locationLng,
    accuracyM: device.locationAccuracyM,
    source: device.locationSource === "gps" ? "gps" : "cell",
    at: device.locationAt.toISOString(),
  };
}

type LoopName = { id: string; name: string; compiledVideoKey: string | null };

type CabContext = {
  snapshot: LoopRoutingSnapshot;
  thresholdMs: number;
  heartbeatIntervalMs: number;
  lagSettings: { heartbeatIntervalSeconds: number; syncIntervalSeconds: number };
  fleetDisabled: boolean;
  fleetReason: string | null;
  now: Date;
};

/** How far back run starts and journey evidence look. */
export const RUN_START_LOOKBACK_MS = 30 * 24 * 3600_000;
const JOURNEY_LOOKBACK_MS = JOURNEY_EVIDENCE_DAYS * 24 * 3600_000;
/** How long the 30-day journey evidence is reused before it is looked up again. */
const JOURNEY_EVIDENCE_TTL_MS = 10 * 60_000;

// In-process memos (the app runs as one Node process). Both only save work: a miss recomputes.
type RunStartMemo = { runStart: Date; through: Date };
const memo = (globalThis as unknown as { __orisonMobileMemo?: { runStarts: Map<string, RunStartMemo>; journeys: Map<string, { value: boolean; at: number }> } })
  .__orisonMobileMemo ?? { runStarts: new Map<string, RunStartMemo>(), journeys: new Map<string, { value: boolean; at: number }>() };
(globalThis as unknown as { __orisonMobileMemo?: typeof memo }).__orisonMobileMemo = memo;

/**
 * Start of the current unbroken heartbeat run, for devices whose run reaches back past the loaded
 * window, in one query for all of them. Bounded to the last RUN_START_LOOKBACK_MS; if no gap is
 * found in that window, the start of the window is returned. A run start found earlier is reused
 * while the loaded window shows the run has not been broken since it was found.
 */
async function findRunStarts(requests: Array<{ id: string; windowStart: Date }>, gapMs: number, now: Date) {
  const result = new Map<string, Date>();
  const toQuery: string[] = [];
  for (const request of requests) {
    const known = memo.runStarts.get(request.id);
    if (known && known.through.getTime() >= request.windowStart.getTime()) {
      result.set(request.id, known.runStart);
      memo.runStarts.set(request.id, { runStart: known.runStart, through: now });
    } else {
      toQuery.push(request.id);
    }
  }
  if (toQuery.length > 0) {
    const since = new Date(now.getTime() - RUN_START_LOOKBACK_MS);
    const rows = await prisma.$queryRaw<Array<{ deviceId: string; start: Date }>>`
      SELECT "deviceId", MAX("receivedAt") AS start FROM (
        SELECT "deviceId", "receivedAt", LAG("receivedAt") OVER (PARTITION BY "deviceId" ORDER BY "receivedAt") AS prev
        FROM "DeviceHeartbeat" WHERE "deviceId" = ANY(${toQuery}) AND "receivedAt" >= ${since}
      ) t
      WHERE prev IS NULL OR EXTRACT(EPOCH FROM ("receivedAt" - prev)) * 1000 > ${gapMs}
      GROUP BY "deviceId"`;
    for (const row of rows) {
      result.set(row.deviceId, row.start);
      memo.runStarts.set(row.deviceId, { runStart: row.start, through: now });
    }
  }
  return result;
}

/** Latest heartbeat of each device, in one query (an index lookup per device). */
async function latestHeartbeats(deviceIds: string[]) {
  const map = new Map<string, LatestHeartbeat>();
  if (deviceIds.length === 0) return map;
  const rows = await prisma.$queryRaw<Array<LatestHeartbeat & { deviceId: string }>>`
    SELECT d.id AS "deviceId", h."receivedAt", h."uptimeSeconds", h."playerStatus", h."signalStrength", h."signalPercent",
           h."networkType", h."cpuTemp", h."storageFreeMb", h."locationData"->>'method' AS "locationMethod"
    FROM unnest(${deviceIds}::text[]) AS d(id)
    CROSS JOIN LATERAL (
      SELECT * FROM "DeviceHeartbeat" WHERE "deviceId" = d.id ORDER BY "receivedAt" DESC LIMIT 1
    ) h`;
  for (const row of rows) {
    const { deviceId, ...latest } = row;
    map.set(deviceId, latest);
  }
  return map;
}

/**
 * Devices that reported a passenger journey (player "playing" or "silent") in the last
 * JOURNEY_LOOKBACK_MS. `seenInWindow` are devices already known from the loaded heartbeats; the
 * rest are looked up in one query, reused for JOURNEY_EVIDENCE_TTL_MS.
 */
async function journeyEvidence(deviceIds: string[], seenInWindow: Set<string>, now: Date) {
  const result = new Set<string>(seenInWindow);
  const toQuery: string[] = [];
  for (const id of deviceIds) {
    if (seenInWindow.has(id)) {
      memo.journeys.set(id, { value: true, at: now.getTime() });
      continue;
    }
    const known = memo.journeys.get(id);
    if (known && now.getTime() - known.at < JOURNEY_EVIDENCE_TTL_MS) {
      if (known.value) result.add(id);
    } else {
      toQuery.push(id);
    }
  }
  if (toQuery.length > 0) {
    const since = new Date(now.getTime() - JOURNEY_LOOKBACK_MS);
    const rows = await prisma.$queryRaw<Array<{ deviceId: string }>>`
      SELECT DISTINCT "deviceId" FROM "DeviceHeartbeat"
      WHERE "deviceId" = ANY(${toQuery}) AND "receivedAt" >= ${since} AND "playerStatus" IN ('playing', 'silent')`;
    const found = new Set(rows.map((row) => row.deviceId));
    for (const id of toQuery) {
      memo.journeys.set(id, { value: found.has(id), at: now.getTime() });
      if (found.has(id)) result.add(id);
    }
  }
  return result;
}

/** Names of the loops cabs report or are overridden to: published ones come with the snapshot. */
async function loopNamesFor(ids: Array<string | null>, snapshot: LoopRoutingSnapshot) {
  const names = new Map<string, LoopName>();
  const missing = new Set<string>();
  for (const id of ids) {
    if (!id || id === BUILT_IN_LOOP_ID) continue;
    const loop = snapshot.loops.get(id);
    if (loop) names.set(id, { id: loop.id, name: loop.name, compiledVideoKey: loop.compiledVideoKey ?? null });
    else missing.add(id);
  }
  if (missing.size > 0) {
    const rows = await prisma.loop.findMany({ where: { id: { in: [...missing] } }, select: { id: true, name: true, compiledVideoKey: true } });
    for (const row of rows) names.set(row.id, row);
  }
  return names;
}

type CabInput = {
  device: CabDeviceRow;
  group: { id: string; name: string } | null;
  heartbeatTimes: Date[];
  /** Player status of each loaded heartbeat (journey evidence without another query). */
  heartbeatStatuses: Array<string | null>;
  latest: LatestHeartbeat | null;
  windowStart: Date;
};

/** First pass: intervals and whether the current run may start before the loaded window. */
function cabIntervals(input: CabInput, context: CabContext) {
  const online = isDeviceOnline(input.device.lastHeartbeatAt, context.thresholdMs, context.now);
  const intervals = heartbeatIntervals(input.heartbeatTimes, context.thresholdMs, context.now, context.heartbeatIntervalMs);
  const current = online ? intervals[intervals.length - 1] ?? null : null;
  const needsRunStart = Boolean(current && current.start.getTime() - input.windowStart.getTime() <= context.thresholdMs);
  return { online, intervals, current, needsRunStart };
}

function buildCabSummary(
  input: CabInput,
  context: CabContext,
  extra: {
    intervals: ReturnType<typeof cabIntervals>;
    runStart: Date | null;
    loopNames: Map<string, LoopName>;
    hasReportedJourney: boolean;
  },
): CabSummary {
  const { device, latest } = input;
  const { now } = context;
  const { online, intervals, current } = extra.intervals;
  const resolution = resolveDeviceLoop(device, context.snapshot);
  const expectedLoop = resolution.loop;
  const status = resolveMobileDeviceStatus(device, expectedLoop?.id ?? null, {
    thresholdMs: context.thresholdMs,
    fleetDisabled: context.fleetDisabled,
    now,
  });

  let onlineSince: Date | null = current?.start ?? null;
  if (current && extra.intervals.needsRunStart) {
    onlineSince = extra.runStart ?? current.start;
  }

  const midnight = startOfLocalDay(now, LONDON_TZ);
  const secondsToday = coveredSeconds(intervals, midnight, now);

  const builtIn = device.currentLoopId === BUILT_IN_LOOP_ID;
  const playing = device.currentLoopId && !builtIn ? extra.loopNames.get(device.currentLoopId) : undefined;
  const pausedReason = device.isDisabled
    ? device.disabledReason ?? null
    : context.fleetDisabled
      ? context.fleetReason ?? "All cabs are paused"
      : null;
  const playbackTrigger = parsePlaybackTrigger(device.playbackTrigger);
  const reported = reportedState(device, latest);
  const sync = summarizeSync(device, expectedLoop?.id ?? null);
  const failedLoop = device.syncFailedLoopId ? extra.loopNames.get(device.syncFailedLoopId) : undefined;

  return {
    id: device.id,
    serialNumber: device.serialNumber,
    label: device.cabLicenseNumber || device.serialNumber,
    driverName: device.driverName,
    group: input.group,
    status,
    playerStatus: online ? normalizePlayerStatus(reported?.playerStatus) : "unknown",
    lastSeenAt: device.lastHeartbeatAt?.toISOString() ?? null,
    playing:
      device.currentLoopId && !builtIn
        ? {
            id: device.currentLoopId,
            name: playing?.name ?? "A video that’s no longer in the library",
            posterUrl: posterUrlFor(playing ? { id: playing.id, compiledVideoKey: playing.compiledVideoKey } : null),
          }
        : null,
    expected: expectedLoop
      ? { id: expectedLoop.id, name: expectedLoop.name, posterUrl: posterUrlFor(expectedLoop) }
      : null,
    expectedSource: resolution.source,
    isUpToDate: Boolean(expectedLoop && device.currentLoopId === expectedLoop.id),
    uptimeSeconds:
      online && reported?.uptimeSeconds != null
        ? reported.uptimeSeconds + Math.max(0, Math.round((now.getTime() - reported.at.getTime()) / 1000))
        : null,
    onlineSince: onlineSince?.toISOString() ?? null,
    hoursOnlineToday: Math.round((secondsToday / 3600) * 10) / 10,
    secondsOnlineToday: Math.round(secondsToday),
    inServiceSince: device.createdAt.toISOString(),
    location: deviceLocation(device),
    isPaused: device.isDisabled || context.fleetDisabled,
    pausedReason,
    cabPaused: device.isDisabled,
    fleetPaused: context.fleetDisabled,
    changeLagMinutes: changeLagMinutesFor(device.firmwareVersion, context.lagSettings),
    playingBuiltIn: builtIn,
    positionReporting: device.locationSource === "gps" ? "gps" : device.locationAt && device.locationSource ? "cell" : positionReportingFrom(latest),
    playbackTrigger,
    reportsJourneys: reportsJourneys(playbackTrigger, extra.hasReportedJourney),
    playerState: online ? device.playerState ?? null : null,
    sync: {
      state: sync.state,
      error: sync.error,
      since: sync.since?.toISOString() ?? null,
      nextRetryAt: sync.nextRetryAt?.toISOString() ?? null,
      lastSyncedAt: sync.lastSyncedAt?.toISOString() ?? null,
      failedLoop: device.syncFailedLoopId
        ? { id: device.syncFailedLoopId, name: failedLoop?.name ?? "a video that’s no longer in the library" }
        : null,
    },
  };
}

async function loadCabContext(snapshot?: LoopRoutingSnapshot) {
  const [routing, settings, fleetControl] = await Promise.all([
    snapshot ?? getLoopRoutingSnapshot(),
    getCmsSettings(),
    getFleetControlState(),
  ]);
  return {
    context: {
      snapshot: routing,
      thresholdMs: offlineThresholdMs(settings.heartbeatIntervalSeconds),
      heartbeatIntervalMs: settings.heartbeatIntervalSeconds * 1000,
      lagSettings: {
        heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
        syncIntervalSeconds: settings.syncIntervalSeconds,
      },
      fleetDisabled: fleetControl.disabled,
      fleetReason: fleetControl.reason,
      now: new Date(),
    } satisfies CabContext,
    settings,
  };
}

/** For a set of cabs: a few batched lookups (never one per cab), then the summaries. */
async function summarizeCabs(inputs: CabInput[], context: CabContext) {
  const firstPass = inputs.map((input) => cabIntervals(input, context));
  const runStartRequests = inputs
    .filter((_, index) => firstPass[index].needsRunStart)
    .map((input) => ({ id: input.device.id, windowStart: input.windowStart }));
  // Journey evidence is only needed for cabs that report no trigger (firmware before 1.2.0).
  const untriggered = inputs.filter((input) => !parsePlaybackTrigger(input.device.playbackTrigger));
  const seenInWindow = new Set(
    untriggered
      .filter((input) => isJourneyStatus(input.device.playerStatus) || input.heartbeatStatuses.some(isJourneyStatus))
      .map((input) => input.device.id),
  );
  const [runStarts, journeys, loopNames] = await Promise.all([
    runStartRequests.length ? findRunStarts(runStartRequests, context.thresholdMs, context.now) : Promise.resolve(new Map<string, Date>()),
    untriggered.length
      ? journeyEvidence(
          untriggered.map((input) => input.device.id),
          seenInWindow,
          context.now,
        )
      : Promise.resolve(new Set<string>()),
    loopNamesFor(inputs.flatMap((input) => [input.device.currentLoopId, input.device.syncFailedLoopId]), context.snapshot),
  ]);
  const cabs = inputs.map((input, index) =>
    buildCabSummary(input, context, {
      intervals: firstPass[index],
      runStart: runStarts.get(input.device.id) ?? null,
      loopNames,
      hasReportedJourney: journeys.has(input.device.id),
    }),
  );
  return { cabs, intervals: firstPass.map((pass) => pass.intervals) };
}

export async function listCabSummaries(snapshot: LoopRoutingSnapshot, groups: Array<{ id: string; name: string }>) {
  const { context, settings } = await loadCabContext(snapshot);
  const windowStart = new Date(Math.min(startOfLocalDay(context.now, LONDON_TZ).getTime(), context.now.getTime() - 24 * 3600_000));
  const devices = await prisma.device.findMany({
    where: { isActive: true },
    orderBy: [{ cabLicenseNumber: "asc" }, { serialNumber: "asc" }],
    select: {
      ...cabDeviceSelect,
      heartbeats: {
        where: { receivedAt: { gte: windowStart } },
        orderBy: { receivedAt: "asc" },
        select: { receivedAt: true, playerStatus: true },
      },
    },
  });
  const latest = await latestHeartbeats(devices.filter(needsLatestHeartbeat).map((device) => device.id));
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const { cabs } = await summarizeCabs(
    devices.map((device) => ({
      device,
      group: device.groupId ? groupsById.get(device.groupId) ?? null : null,
      heartbeatTimes: device.heartbeats.map((heartbeat) => heartbeat.receivedAt),
      heartbeatStatuses: device.heartbeats.map((heartbeat) => heartbeat.playerStatus),
      latest: latest.get(device.id) ?? null,
      windowStart,
    })),
    context,
  );
  return { cabs, devices, context, settings };
}

function trailPoint(locationData: unknown, receivedAt: Date): CabLocation | null {
  if (!locationData || typeof locationData !== "object") {
    return null;
  }
  const record = locationData as Record<string, unknown>;
  const resolved = record.resolved as Record<string, unknown> | null | undefined;
  if (resolved && typeof resolved.lat === "number" && typeof resolved.lng === "number") {
    return {
      lat: resolved.lat,
      lng: resolved.lng,
      accuracyM: typeof resolved.accuracyM === "number" ? resolved.accuracyM : null,
      source: resolved.source === "gps" ? "gps" : "cell",
      at: typeof resolved.at === "string" ? resolved.at : receivedAt.toISOString(),
    };
  }
  // Heartbeats stored before server-side resolution: only trust explicit GPS coordinates.
  if (record.method === "gps" && typeof record.lat === "number" && typeof record.lng === "number") {
    return {
      lat: record.lat,
      lng: record.lng,
      accuracyM: typeof record.accuracyM === "number" ? record.accuracyM : null,
      source: "gps",
      at: receivedAt.toISOString(),
    };
  }
  return null;
}

/**
 * A positive mobile signal figure is a quality percentage (the NetworkManager fallback reports
 * 0-100), a negative one is dBm (the modem). Firmware 1.2.0 sends them as separate fields.
 */
export function splitSignal(value: number | null | undefined, percent?: number | null) {
  const signalPercent =
    typeof percent === "number" && percent >= 0 && percent <= 100 ? percent : typeof value === "number" && value > 0 && value <= 100 ? value : null;
  const signalDbm = typeof value === "number" && value < 0 ? value : null;
  return { signalPercent, signalDbm };
}

export async function getCabDetail(deviceId: string) {
  const { context } = await loadCabContext();
  const windowStart = new Date(context.now.getTime() - 24 * 3600_000);
  const midnight = startOfLocalDay(context.now, LONDON_TZ);
  const loadFrom = new Date(Math.min(windowStart.getTime(), midnight.getTime()));

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      ...cabDeviceSelect,
      group: { select: { id: true, name: true } },
      notes: true,
      heartbeats: {
        where: { receivedAt: { gte: loadFrom } },
        orderBy: { receivedAt: "desc" },
        select: { ...latestHeartbeatSelect, locationData: true },
      },
    },
  });
  if (!device) {
    throw new ApiError("Cab not found", 404);
  }

  const newest = device.heartbeats[0];
  const latest: LatestHeartbeat | null = newest
    ? { ...newest, locationMethod: locationMethodOf(newest.locationData) }
    : (await latestHeartbeats([device.id])).get(device.id) ?? null;

  const { cabs, intervals: [intervals] } = await summarizeCabs(
    [
      {
        device,
        group: device.group,
        heartbeatTimes: device.heartbeats.map((heartbeat) => heartbeat.receivedAt),
        heartbeatStatuses: device.heartbeats.map((heartbeat) => heartbeat.playerStatus),
        latest,
        windowStart: loadFrom,
      },
    ],
    context,
  );
  const summary = cabs[0];

  const trail: CabLocation[] = [];
  let lastKey: string | null = null;
  for (const heartbeat of device.heartbeats) {
    const point = trailPoint(heartbeat.locationData, heartbeat.receivedAt);
    if (!point) continue;
    const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
    if (key === lastKey) continue;
    lastKey = key;
    trail.push(point);
    if (trail.length >= 20) break;
  }
  if (trail.length === 0 && summary.location) {
    trail.push(summary.location);
  }

  const timeline = intervals
    .map((interval) => ({
      start: new Date(Math.max(interval.start.getTime(), windowStart.getTime())),
      end: interval.end,
    }))
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({ start: interval.start.toISOString(), end: interval.end.toISOString() }));

  const overrideNames = device.overrideLoopId ? await loopNamesFor([device.overrideLoopId], context.snapshot) : new Map<string, LoopName>();
  const overrideLoop = device.overrideLoopId ? overrideNames.get(device.overrideLoopId) : undefined;
  const reported = reportedState(device, latest);

  return {
    ...summary,
    // Kept for older clients: dBm when known, else the percentage (as cabs used to send it).
    signalStrength: reported?.signalDbm ?? reported?.signalPercent ?? latest?.signalStrength ?? null,
    /** Additive: the signal as a 0-100 quality figure when that is what the cab reports. */
    signalPercent: reported?.signalPercent ?? null,
    /** Additive: the signal in dBm when the cab's modem reports it. */
    signalDbm: reported?.signalDbm ?? null,
    // Firmware before 1.2.0 hard-codes "4g" whatever the connection: not shown (as on the desktop).
    networkType: detectedNetworkType(reported?.networkType ?? null, device.firmwareVersion),
    storageFreeMb: device.storageFreeMb ?? latest?.storageFreeMb ?? null,
    // Not kept on the Device row: from the newest heartbeat.
    cpuTemp: latest?.cpuTemp ?? null,
    firmwareVersion: device.firmwareVersion,
    notes: device.notes,
    /** Additive: when the technical figures (signal, storage, temperature) were reported. */
    reportedAt: (reported?.at ?? latest?.receivedAt)?.toISOString() ?? null,
    override: device.overrideLoopId
      ? { id: device.overrideLoopId, name: overrideLoop?.name ?? "Deleted loop" }
      : null,
    trail,
    timeline,
  };
}

function locationMethodOf(locationData: unknown) {
  if (!locationData || typeof locationData !== "object") return null;
  const method = (locationData as Record<string, unknown>).method;
  return typeof method === "string" ? method : null;
}

const latestHeartbeatSelect = {
  receivedAt: true,
  uptimeSeconds: true,
  playerStatus: true,
  signalStrength: true,
  signalPercent: true,
  networkType: true,
  cpuTemp: true,
  storageFreeMb: true,
} satisfies Prisma.DeviceHeartbeatSelect;

// ---------------------------------------------------------------------------------------------
// Overview

/**
 * `user` is the phone app's actor: a signed-in user, or the shared "not signed in" identity
 * (anonymous). The anonymous caller gets no email and no activity feed (it names team members and
 * what they did; the phone app does not show it).
 *
 * Query budget (independent of the number of cabs): routing snapshot (3), settings, fleet
 * control, groups, devices (with their latest reported state) + their heartbeats since the window
 * start (2), the fleet video (1); plus, only when needed: the newest heartbeat of cabs whose Device
 * row has no reported state yet or that have no position (1), run starts reaching past the window
 * (1, then reused), journey evidence for cabs that report no trigger (1, reused for 10 minutes),
 * names of reported videos that are not published (1) and the activity feed for a signed-in user (1).
 */
export async function getMobileOverview(user: { id: string; name: string; email: string | null; role: string; anonymous?: boolean }) {
  const snapshot = await getLoopRoutingSnapshot();
  const fleetLoop = resolveFleetLoop(snapshot);
  const groups = await prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  const [{ cabs, devices, context }, recentActivity, fleetLoopRow] = await Promise.all([
    listCabSummaries(snapshot, groups),
    user.anonymous
      ? Promise.resolve([])
      : prisma.activityEvent.findMany({
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, type: true, message: true, createdAt: true },
        }),
    fleetLoop ? prisma.loop.findUnique({ where: { id: fleetLoop.id }, select: loopSummarySelect }) : Promise.resolve(null),
  ]);

  const liveOn = buildLiveOnIndex(snapshot, groups, devices);

  const changeLag = summarizeChangeLag(
    cabs.map((cab) => cab.changeLagMinutes),
    context.lagSettings,
  );
  const counts = { total: cabs.length, online: 0, updating: 0, offline: 0, paused: 0 };
  for (const cab of cabs) {
    if (cab.status !== "inactive") {
      counts[cab.status] += 1;
    }
  }

  return {
    generatedAt: context.now.toISOString(),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, signedIn: !user.anonymous },
    counts,
    fleetLoop: fleetLoopRow ? toLoopSummary(fleetLoopRow, liveOn, context.now) : null,
    fleetPaused: context.fleetDisabled,
    // Honest worst case for the fleet: cabs on firmware before 1.1.0 only check every sync
    // interval (30 minutes), newer ones within a heartbeat. `changeLag` gives the range.
    changeLagMinutes: changeLag.maxMinutes,
    changeLag,
    groups: groups.map((group) => {
      const members = cabs.filter((cab) => cab.group?.id === group.id);
      const resolved = resolveGroupLoop(group.id, snapshot);
      return {
        id: group.id,
        name: group.name,
        cabCount: members.length,
        // Cabs that are connected (online or updating).
        onlineCount: members.filter((cab) => cab.status === "online" || cab.status === "updating").length,
        followsFleet: resolved.followsFleet,
        loop: resolved.loop
          ? { id: resolved.loop.id, name: resolved.loop.name, posterUrl: posterUrlFor(resolved.loop) }
          : null,
      };
    }),
    cabs,
    recentActivity: recentActivity.map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}
