// What a heartbeat changes on the Device row, and which activity events it causes. Pure, so the
// rules for old firmware (1.0.0 in the field) and 1.2.0+ can be tested side by side.

import type { ActivityEventType, DeviceHeartbeatInput } from "@orison/shared";

export type SignalReading = { signalPercent: number | null; signalDbm: number | null };

/**
 * Firmware 1.2.0+ sends dBm in signalStrength (only when known) and a 0-100 quality figure in
 * signalPercent. Older firmware sends whichever it has in signalStrength: the real cab reports
 * through the NetworkManager fallback, which gives a positive percentage (62), not dBm.
 * Returns undefined when the heartbeat said nothing about signal (keep what is stored).
 */
export function readSignal(body: Pick<DeviceHeartbeatInput, "signalStrength" | "signalPercent">): SignalReading | undefined {
  if (body.signalStrength === undefined && body.signalPercent === undefined) {
    return undefined;
  }
  const strength = typeof body.signalStrength === "number" ? body.signalStrength : null;
  const dbm = strength !== null && strength < 0 ? strength : null;
  const legacyPercent = strength !== null && strength >= 0 && strength <= 100 ? strength : null;
  const percent = typeof body.signalPercent === "number" ? Math.round(body.signalPercent) : legacyPercent;
  return { signalPercent: percent, signalDbm: dbm };
}

export type PreviousDeviceState = {
  id: string;
  serialNumber: string;
  currentLoopId: string | null;
  lastSyncAt: Date | null;
  syncState: string | null;
  syncFailedLoopId: string | null;
} | null;

export type HeartbeatActivity = {
  type: ActivityEventType;
  message: string;
  metadata: Record<string, string | number | boolean | null>;
};

type DeviceFields = Partial<{
  ipAddress: string | null;
  firmwareVersion: string | null;
  storageFreeMb: number | null;
  currentLoopId: string | null;
  lastHeartbeatAt: Date;
  lastSyncAt: Date;
  playerStatus: string | null;
  playbackTrigger: string | null;
  signalPercent: number | null;
  signalDbm: number | null;
  networkType: string | null;
  uptimeSeconds: number | null;
  safetyChecksum: string | null;
  statusReportedAt: Date;
  syncState: string | null;
  syncError: string | null;
  syncFailedLoopId: string | null;
  syncStateSince: Date | null;
  syncNextRetryAt: Date | null;
}>;

function parseTime(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A field the heartbeat did not carry stays as stored (undefined); null clears it. */
function carried<T>(value: T | undefined) {
  return value === undefined ? undefined : value;
}

export function applyHeartbeat(
  body: DeviceHeartbeatInput,
  previous: PreviousDeviceState,
  now: Date,
  loopName: (loopId: string) => string | null = () => null,
): { fields: DeviceFields; activity: HeartbeatActivity[] } {
  const serial = body.serialNumber;
  const fields: DeviceFields = {
    ipAddress: carried(body.ipAddress),
    firmwareVersion: carried(body.firmwareVersion),
    storageFreeMb: carried(body.storageFreeMb),
    currentLoopId: carried(body.currentLoopId),
    lastHeartbeatAt: now,
  };
  const activity: HeartbeatActivity[] = [];

  // A full heartbeat (the health monitor's) carries the player status; the sync agent's short
  // post-activation heartbeat (firmware 1.0.0/1.1.0) carries only the loop and storage.
  if (body.playerStatus !== undefined) {
    fields.playerStatus = body.playerStatus;
    fields.uptimeSeconds = carried(body.uptimeSeconds);
    fields.networkType = carried(body.networkType);
    fields.statusReportedAt = now;
  }
  if (body.playbackTrigger !== undefined) {
    fields.playbackTrigger = body.playbackTrigger;
  }
  if (body.safetyChecksum !== undefined) {
    fields.safetyChecksum = body.safetyChecksum;
  }
  const signal = readSignal(body);
  if (signal) {
    fields.signalPercent = signal.signalPercent;
    fields.signalDbm = signal.signalDbm;
  }

  if (!previous) {
    activity.push({
      type: "DEVICE_REGISTERED",
      message: `Cab ${serial} registered itself with its first heartbeat`,
      metadata: { serialNumber: serial, firmwareVersion: body.firmwareVersion ?? null },
    });
  }

  const sync = body.sync ?? null;
  if (sync) {
    // Firmware 1.2.0+: the cab says how its sync is going.
    fields.syncState = sync.state;
    fields.syncError = sync.state === "failed" ? sync.error ?? "Sync failed (no reason given)" : null;
    fields.syncFailedLoopId = sync.state === "failed" ? sync.failedLoopId ?? null : null;
    fields.syncStateSince = parseTime(sync.since) ?? (previous?.syncState === sync.state ? undefined : now);
    fields.syncNextRetryAt = parseTime(sync.nextRetryAt);
    const reportedSyncAt = parseTime(sync.lastSyncedAt);
    // A cab clock far ahead of ours is not believed (a few minutes of skew is).
    const lastSyncedAt = reportedSyncAt && reportedSyncAt.getTime() <= now.getTime() + 10 * 60_000 ? reportedSyncAt : null;
    const syncedLater = lastSyncedAt && (!previous?.lastSyncAt || lastSyncedAt > previous.lastSyncAt);
    if (lastSyncedAt && syncedLater) {
      fields.lastSyncAt = lastSyncedAt;
      if (previous) {
        const loopId = body.currentLoopId ?? null;
        activity.push({
          type: "DEVICE_SYNCED",
          message: `Cab ${serial} is now playing ${loopId ? loopName(loopId) ?? "a new loop" : "its new content"}`,
          metadata: { deviceId: previous.id, serialNumber: serial, loopId, syncedAt: lastSyncedAt.toISOString() },
        });
      }
    }
    const newlyFailed =
      sync.state === "failed" &&
      (previous?.syncState !== "failed" || (previous?.syncFailedLoopId ?? null) !== (sync.failedLoopId ?? null));
    if (newlyFailed) {
      activity.push({
        type: "SYNC_FAILED",
        message: `Cab ${serial} could not update: ${fields.syncError}`,
        metadata: {
          deviceId: previous?.id ?? null,
          serialNumber: serial,
          failedLoopId: sync.failedLoopId ?? null,
          error: fields.syncError ?? null,
        },
      });
    }
  } else if (
    previous &&
    body.currentLoopId &&
    previous.currentLoopId !== body.currentLoopId
  ) {
    // Older firmware reports no sync state; a change of the loop it plays is a completed sync.
    fields.lastSyncAt = now;
    activity.push({
      type: "DEVICE_SYNCED",
      message: `Cab ${serial} is now playing ${loopName(body.currentLoopId) ?? "a new loop"}`,
      metadata: { deviceId: previous.id, serialNumber: serial, loopId: body.currentLoopId, syncedAt: now.toISOString() },
    });
  }

  return { fields, activity };
}
