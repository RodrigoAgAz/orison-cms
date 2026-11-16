// Pure device status rules shared by the desktop pages and the mobile API.

export const MIN_OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;

/** A device is offline when it has not sent a heartbeat within max(3 x interval, 10 minutes). */
export function offlineThresholdMs(heartbeatIntervalSeconds: number | null | undefined) {
  const interval = Number.isFinite(heartbeatIntervalSeconds) && heartbeatIntervalSeconds! > 0
    ? heartbeatIntervalSeconds!
    : 300;
  return Math.max(3 * interval * 1000, MIN_OFFLINE_THRESHOLD_MS);
}

export function isDeviceOnline(
  lastHeartbeatAt: Date | null | undefined,
  thresholdMs: number,
  now: Date = new Date(),
) {
  return Boolean(lastHeartbeatAt && now.getTime() - lastHeartbeatAt.getTime() <= thresholdMs);
}

type StatusDevice = {
  isActive: boolean;
  isDisabled?: boolean;
  lastHeartbeatAt: Date | null;
  currentLoopId: string | null;
};

/** Desktop labels: inactive | offline | outdated | online. */
export function resolveDesktopDeviceStatus(
  device: StatusDevice,
  expectedLoopId: string | null,
  thresholdMs: number,
  now: Date = new Date(),
): "inactive" | "offline" | "outdated" | "online" {
  if (!device.isActive) {
    return "inactive";
  }
  if (!isDeviceOnline(device.lastHeartbeatAt, thresholdMs, now)) {
    return "offline";
  }
  if (expectedLoopId && device.currentLoopId !== expectedLoopId) {
    return "outdated";
  }
  return "online";
}

export type MobileCabStatus = "online" | "updating" | "offline" | "paused" | "inactive";

/** Mobile labels: adds "paused" (cab or fleet disabled) and calls "outdated" "updating". */
export function resolveMobileDeviceStatus(
  device: StatusDevice,
  expectedLoopId: string | null,
  options: { thresholdMs: number; fleetDisabled: boolean; now?: Date },
): MobileCabStatus {
  if (!device.isActive) {
    return "inactive";
  }
  if (device.isDisabled || options.fleetDisabled) {
    return "paused";
  }
  const desktop = resolveDesktopDeviceStatus(device, expectedLoopId, options.thresholdMs, options.now);
  return desktop === "outdated" ? "updating" : (desktop as MobileCabStatus);
}

/**
 * Turn heartbeat timestamps into online intervals. Two consecutive heartbeats belong to the same
 * run when they are no more than `gapMs` apart. A run that is still live (its last heartbeat is
 * within gapMs of now) ends at `now`; a closed run ends `tailMs` after its last heartbeat.
 */
export function heartbeatIntervals(
  timestamps: Date[],
  gapMs: number,
  now: Date = new Date(),
  tailMs = 0,
): Array<{ start: Date; end: Date }> {
  const sorted = timestamps.map((t) => t.getTime()).sort((a, b) => a - b);
  const intervals: Array<{ start: number; end: number }> = [];
  for (const t of sorted) {
    const last = intervals[intervals.length - 1];
    if (last && t - last.end <= gapMs) {
      last.end = t;
    } else {
      intervals.push({ start: t, end: t });
    }
  }
  const nowMs = now.getTime();
  intervals.forEach((interval, index) => {
    const isLast = index === intervals.length - 1;
    if (isLast && nowMs - interval.end <= gapMs) {
      // Still live: the run extends to now.
      interval.end = Math.max(interval.end, nowMs);
    } else {
      // Closed run: credit one heartbeat interval after the last heartbeat (never past now).
      interval.end = Math.min(interval.end + tailMs, nowMs);
    }
  });
  return intervals.map((interval) => ({ start: new Date(interval.start), end: new Date(interval.end) }));
}

/** Seconds of [from, to] covered by the intervals. */
export function coveredSeconds(intervals: Array<{ start: Date; end: Date }>, from: Date, to: Date) {
  let total = 0;
  for (const interval of intervals) {
    const start = Math.max(interval.start.getTime(), from.getTime());
    const end = Math.min(interval.end.getTime(), to.getTime());
    if (end > start) {
      total += end - start;
    }
  }
  return total / 1000;
}

/** UTC instant of the most recent local midnight in `timeZone` (default Europe/London). */
export function startOfLocalDay(now: Date = new Date(), timeZone = "Europe/London") {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Wall-clock time in the zone, expressed as if it were UTC, minus the actual instant = offset.
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const midnightWallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"));
  // Offset may differ at midnight on DST change days; re-derive once at the candidate instant.
  let candidate = midnightWallAsUtc - offsetMs;
  const check = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(
    new Date(candidate),
  );
  const hourAtCandidate = Number(check);
  if (hourAtCandidate !== 0) {
    candidate -= (hourAtCandidate > 12 ? hourAtCandidate - 24 : hourAtCandidate) * 60 * 60 * 1000;
  }
  return new Date(candidate);
}
