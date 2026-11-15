// Server-side data assembly for the mobile JSON API (/api/m/*). Shapes follow CONTRACT.md.

import { prisma, type Prisma } from "@orison/db";

import { getCmsSettings } from "./cms-settings";
import {
  coveredSeconds,
  heartbeatIntervals,
  isDeviceOnline,
  offlineThresholdMs,
  resolveMobileDeviceStatus,
  startOfLocalDay,
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
import { STALE_PUBLISHING_MESSAGE, STALE_PUBLISHING_MS } from "./loops";

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
  _count: { select: { slots: true } },
} satisfies Prisma.LoopSelect;

type LoopRow = Prisma.LoopGetPayload<{ select: typeof loopSummarySelect }>;

export type LoopProcessing = { state: "processing" | "ready" | "failed"; error: string | null };

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
  liveOn: { fleet: boolean; groups: { id: string; name: string }[]; cabCount: number };
};

export function loopProcessing(
  loop: Pick<LoopRow, "status" | "publishError" | "updatedAt">,
  now = new Date(),
): LoopProcessing {
  if (loop.status === "PUBLISHING") {
    if (now.getTime() - loop.updatedAt.getTime() > STALE_PUBLISHING_MS) {
      return { state: "failed", error: STALE_PUBLISHING_MESSAGE };
    }
    return { state: "processing", error: null };
  }
  if (loop.status === "PUBLISHED") {
    // A publish that succeeded but whose requested target could not be applied keeps a note.
    return { state: "ready", error: loop.publishError ?? null };
  }
  if (loop.publishError) {
    return { state: "failed", error: loop.publishError };
  }
  return { state: "ready", error: null };
}

export function posterUrlFor(loop: { id: string; compiledVideoKey: string | null } | null | undefined) {
  return loop?.compiledVideoKey ? `/api/m/loops/${loop.id}/poster` : null;
}

export function videoUrlFor(loop: { compiledVideoKey: string | null }) {
  // Same-origin; local storage streams with Range support, S3 redirects to a signed URL.
  return loop.compiledVideoKey ? `/api/storage/${loop.compiledVideoKey}` : null;
}

type ActiveDeviceForRouting = { id: string; groupId: string | null; overrideLoopId: string | null };

export type LiveOnIndex = {
  fleetLoopId: string | null;
  groupsByLoop: Map<string, { id: string; name: string }[]>;
  cabCountByLoop: Map<string, number>;
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
  for (const device of devices) {
    const loopId = resolveDeviceLoop(device, snapshot).loop?.id;
    if (loopId) {
      cabCountByLoop.set(loopId, (cabCountByLoop.get(loopId) ?? 0) + 1);
    }
  }
  return { fleetLoopId, groupsByLoop, cabCountByLoop };
}

export function toLoopSummary(loop: LoopRow, liveOn: LiveOnIndex, now = new Date()): LoopSummary {
  return {
    id: loop.id,
    name: loop.name,
    status: loop.status,
    processing: loopProcessing(loop, now),
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
    },
  };
}

async function loadRoutingContext() {
  const [snapshot, groups, devices] = await Promise.all([
    getLoopRoutingSnapshot(),
    prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.device.findMany({
      where: { isActive: true },
      select: { id: true, groupId: true, overrideLoopId: true },
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

export async function getMobileLoop(loopId: string) {
  const [row, context] = await Promise.all([
    prisma.loop.findUnique({ where: { id: loopId }, select: loopSummarySelect }),
    loadRoutingContext(),
  ]);
  if (!row) {
    throw new ApiError("Loop not found", 404);
  }
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

export type CabSummary = {
  id: string;
  serialNumber: string;
  label: string;
  driverName: string | null;
  group: { id: string; name: string } | null;
  status: MobileCabStatus;
  playerStatus: "journey" | "silent" | "idle" | "disabled" | "unknown";
  lastSeenAt: string | null;
  playing: LoopRef | null;
  expected: LoopRef | null;
  expectedSource: ExpectedSource | null;
  isUpToDate: boolean;
  uptimeSeconds: number | null;
  onlineSince: string | null;
  hoursOnlineToday: number;
  inServiceSince: string;
  location: CabLocation | null;
  isPaused: boolean;
  pausedReason: string | null;
};

const cabDeviceSelect = {
  id: true,
  serialNumber: true,
  cabLicenseNumber: true,
  driverName: true,
  groupId: true,
  group: { select: { id: true, name: true } },
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
} satisfies Prisma.DeviceSelect;

type CabDeviceRow = Prisma.DeviceGetPayload<{ select: typeof cabDeviceSelect }>;

type LatestHeartbeat = {
  receivedAt: Date;
  uptimeSeconds: number | null;
  playerStatus: string | null;
  signalStrength: number | null;
  networkType: string | null;
  cpuTemp: number | null;
  storageFreeMb: number | null;
};

function normalizePlayerStatus(status: string | null | undefined): CabSummary["playerStatus"] {
  switch (status) {
    case "playing":
      return "journey";
    case "silent":
    case "idle":
    case "disabled":
      return status;
    default:
      return "unknown";
  }
}

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

type CabContext = {
  snapshot: LoopRoutingSnapshot;
  thresholdMs: number;
  heartbeatIntervalMs: number;
  fleetDisabled: boolean;
  fleetReason: string | null;
  loopNames: Map<string, { id: string; name: string; compiledVideoKey: string | null }>;
  now: Date;
};

/**
 * Start of the current unbroken heartbeat run for devices whose run reaches back past the loaded
 * window (one query per such device, using the [deviceId, receivedAt] index).
 */
async function findRunStart(deviceId: string, gapMs: number) {
  const rows = await prisma.$queryRaw<Array<{ receivedAt: Date }>>`
    SELECT "receivedAt" FROM (
      SELECT "receivedAt", LAG("receivedAt") OVER (ORDER BY "receivedAt") AS prev
      FROM "DeviceHeartbeat" WHERE "deviceId" = ${deviceId}
    ) t
    WHERE prev IS NULL OR EXTRACT(EPOCH FROM ("receivedAt" - prev)) * 1000 > ${gapMs}
    ORDER BY "receivedAt" DESC LIMIT 1`;
  return rows[0]?.receivedAt ?? null;
}

async function buildCabSummary(
  device: CabDeviceRow,
  heartbeatTimes: Date[],
  latest: LatestHeartbeat | null,
  context: CabContext,
  windowStart: Date,
): Promise<{ summary: CabSummary; intervals: Array<{ start: Date; end: Date }> }> {
  const { now } = context;
  const resolution = resolveDeviceLoop(device, context.snapshot);
  const expectedLoop = resolution.loop;
  const status = resolveMobileDeviceStatus(device, expectedLoop?.id ?? null, {
    thresholdMs: context.thresholdMs,
    fleetDisabled: context.fleetDisabled,
    now,
  });
  const online = isDeviceOnline(device.lastHeartbeatAt, context.thresholdMs, now);
  const intervals = heartbeatIntervals(heartbeatTimes, context.thresholdMs, now, context.heartbeatIntervalMs);
  const current = online ? intervals[intervals.length - 1] ?? null : null;

  let onlineSince: Date | null = current?.start ?? null;
  if (current && current.start.getTime() - windowStart.getTime() <= context.thresholdMs) {
    // The run may have started before the loaded window.
    onlineSince = (await findRunStart(device.id, context.thresholdMs)) ?? current.start;
  }

  const midnight = startOfLocalDay(now, LONDON_TZ);
  const hoursOnlineToday = Math.round((coveredSeconds(intervals, midnight, now) / 3600) * 10) / 10;

  const playing = device.currentLoopId ? context.loopNames.get(device.currentLoopId) : undefined;
  const pausedReason = device.isDisabled
    ? device.disabledReason ?? null
    : context.fleetDisabled
      ? context.fleetReason ?? "All cabs are paused"
      : null;

  const summary: CabSummary = {
    id: device.id,
    serialNumber: device.serialNumber,
    label: device.cabLicenseNumber || device.serialNumber,
    driverName: device.driverName,
    group: device.group,
    status,
    playerStatus: online ? normalizePlayerStatus(latest?.playerStatus) : "unknown",
    lastSeenAt: device.lastHeartbeatAt?.toISOString() ?? null,
    playing: device.currentLoopId
      ? {
          id: device.currentLoopId,
          name: playing?.name ?? "Unknown loop",
          posterUrl: posterUrlFor(playing ? { id: playing.id, compiledVideoKey: playing.compiledVideoKey } : null),
        }
      : null,
    expected: expectedLoop
      ? { id: expectedLoop.id, name: expectedLoop.name, posterUrl: posterUrlFor(expectedLoop) }
      : null,
    expectedSource: resolution.source,
    isUpToDate: Boolean(expectedLoop && device.currentLoopId === expectedLoop.id),
    uptimeSeconds:
      online && latest?.uptimeSeconds != null
        ? latest.uptimeSeconds + Math.max(0, Math.round((now.getTime() - latest.receivedAt.getTime()) / 1000))
        : null,
    onlineSince: onlineSince?.toISOString() ?? null,
    hoursOnlineToday,
    inServiceSince: device.createdAt.toISOString(),
    location: deviceLocation(device),
    isPaused: device.isDisabled || context.fleetDisabled,
    pausedReason,
  };
  return { summary, intervals };
}

async function loadCabContext(snapshot?: LoopRoutingSnapshot) {
  const [routing, settings, fleetControl, loops] = await Promise.all([
    snapshot ?? getLoopRoutingSnapshot(),
    getCmsSettings(),
    getFleetControlState(),
    prisma.loop.findMany({ select: { id: true, name: true, compiledVideoKey: true } }),
  ]);
  return {
    context: {
      snapshot: routing,
      thresholdMs: offlineThresholdMs(settings.heartbeatIntervalSeconds),
      heartbeatIntervalMs: settings.heartbeatIntervalSeconds * 1000,
      fleetDisabled: fleetControl.disabled,
      fleetReason: fleetControl.reason,
      loopNames: new Map(loops.map((loop) => [loop.id, loop])),
      now: new Date(),
    } satisfies CabContext,
    settings,
  };
}

const latestHeartbeatSelect = {
  receivedAt: true,
  uptimeSeconds: true,
  playerStatus: true,
  signalStrength: true,
  networkType: true,
  cpuTemp: true,
  storageFreeMb: true,
} satisfies Prisma.DeviceHeartbeatSelect;

export async function listCabSummaries(snapshot?: LoopRoutingSnapshot) {
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
        select: { receivedAt: true },
      },
    },
  });
  const latestRows = await Promise.all(
    devices.map((device) =>
      prisma.deviceHeartbeat.findFirst({
        where: { deviceId: device.id },
        orderBy: { receivedAt: "desc" },
        select: latestHeartbeatSelect,
      }),
    ),
  );

  const cabs = await Promise.all(
    devices.map(async (device, index) => {
      const { summary } = await buildCabSummary(
        device,
        device.heartbeats.map((heartbeat) => heartbeat.receivedAt),
        latestRows[index],
        context,
        windowStart,
      );
      return summary;
    }),
  );
  return { cabs, context, settings };
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

export async function getCabDetail(deviceId: string) {
  const { context } = await loadCabContext();
  const windowStart = new Date(context.now.getTime() - 24 * 3600_000);
  const midnight = startOfLocalDay(context.now, LONDON_TZ);
  const loadFrom = new Date(Math.min(windowStart.getTime(), midnight.getTime()));

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      ...cabDeviceSelect,
      firmwareVersion: true,
      storageFreeMb: true,
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

  const latest =
    device.heartbeats[0] ??
    (await prisma.deviceHeartbeat.findFirst({
      where: { deviceId: device.id },
      orderBy: { receivedAt: "desc" },
      select: latestHeartbeatSelect,
    }));

  const { summary, intervals } = await buildCabSummary(
    device,
    device.heartbeats.map((heartbeat) => heartbeat.receivedAt),
    latest,
    context,
    loadFrom,
  );

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

  const overrideLoop = device.overrideLoopId ? context.loopNames.get(device.overrideLoopId) : undefined;

  return {
    ...summary,
    signalStrength: latest?.signalStrength ?? null,
    networkType: latest?.networkType ?? null,
    storageFreeMb: device.storageFreeMb ?? latest?.storageFreeMb ?? null,
    cpuTemp: latest?.cpuTemp ?? null,
    firmwareVersion: device.firmwareVersion,
    notes: device.notes,
    override: device.overrideLoopId
      ? { id: device.overrideLoopId, name: overrideLoop?.name ?? "Deleted loop" }
      : null,
    trail,
    timeline,
  };
}

// ---------------------------------------------------------------------------------------------
// Overview

export async function getMobileOverview(user: { id: string; name: string; email: string; role: string }) {
  const snapshot = await getLoopRoutingSnapshot();
  const [{ cabs, context, settings }, groups, recentActivity, fleetLoopRow] = await Promise.all([
    listCabSummaries(snapshot),
    prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.activityEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, message: true, createdAt: true },
    }),
    (async () => {
      const fleetLoop = resolveFleetLoop(snapshot);
      return fleetLoop ? prisma.loop.findUnique({ where: { id: fleetLoop.id }, select: loopSummarySelect }) : null;
    })(),
  ]);

  const activeDevices = await prisma.device.findMany({
    where: { isActive: true },
    select: { id: true, groupId: true, overrideLoopId: true },
  });
  const liveOn = buildLiveOnIndex(snapshot, groups, activeDevices);

  const counts = { total: cabs.length, online: 0, updating: 0, offline: 0, paused: 0 };
  for (const cab of cabs) {
    if (cab.status !== "inactive") {
      counts[cab.status] += 1;
    }
  }

  return {
    generatedAt: context.now.toISOString(),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    counts,
    fleetLoop: fleetLoopRow ? toLoopSummary(fleetLoopRow, liveOn, context.now) : null,
    fleetPaused: context.fleetDisabled,
    changeLagMinutes: Math.ceil(settings.heartbeatIntervalSeconds / 60),
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
