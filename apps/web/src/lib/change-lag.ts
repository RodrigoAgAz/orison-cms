// How long a cab can take to pick up a change (new video, pause, resume). Pure, unit-tested.
//
// Firmware 1.1.0 and later reads `expectedLoopId` / `disabled` from every heartbeat response and
// syncs at once, so the worst case is one heartbeat interval. Older firmware ignores the heartbeat
// response and only checks for changes every sync interval (device config
// `sync.checkIntervalSeconds`, 30 minutes on every cab in the field; the CMS setting
// `syncIntervalSeconds` records the same value). Unknown versions are treated as old.

export const INSTANT_SYNC_FIRMWARE = "1.1.0";

export function parseFirmwareVersion(version: string | null | undefined): [number, number, number] | null {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function reactsToHeartbeat(firmwareVersion: string | null | undefined) {
  const version = parseFirmwareVersion(firmwareVersion);
  const minimum = parseFirmwareVersion(INSTANT_SYNC_FIRMWARE)!;
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

export type LagSettings = { heartbeatIntervalSeconds: number; syncIntervalSeconds: number };

/** Worst-case minutes (rounded up) for this cab to act on a change once it is switched on. */
export function changeLagMinutesFor(firmwareVersion: string | null | undefined, settings: LagSettings) {
  const seconds = reactsToHeartbeat(firmwareVersion)
    ? settings.heartbeatIntervalSeconds
    : Math.max(settings.syncIntervalSeconds, settings.heartbeatIntervalSeconds);
  return Math.max(1, Math.ceil(seconds / 60));
}

export type ChangeLagSummary = {
  /** Fastest cab's worst case. */
  minMinutes: number;
  /** Slowest cab's worst case: the honest "within about" figure for the whole fleet. */
  maxMinutes: number;
  /** Cabs on firmware older than INSTANT_SYNC_FIRMWARE (or unknown). */
  slowCabs: number;
};

/** Fleet-level figure from per-cab lags. With no cabs, assume old firmware (the slower bound). */
export function summarizeChangeLag(cabLags: number[], settings: LagSettings): ChangeLagSummary {
  if (cabLags.length === 0) {
    const slow = changeLagMinutesFor(null, settings);
    return { minMinutes: slow, maxMinutes: slow, slowCabs: 0 };
  }
  const fast = changeLagMinutesFor(INSTANT_SYNC_FIRMWARE, settings);
  return {
    minMinutes: Math.min(...cabLags),
    maxMinutes: Math.max(...cabLags),
    slowCabs: cabLags.filter((lag) => lag > fast).length,
  };
}
