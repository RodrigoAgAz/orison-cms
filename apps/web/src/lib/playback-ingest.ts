// Playback-log ingestion rules (POST /api/devices/playback-log), kept pure so they can be tested.
// DEVICE_CONTRACT_V2: each entry is validated on its own (valid ones are stored, invalid ones are
// reported and never block the rest), entries whose (device, eventId) is already stored are
// skipped, and an entry's own loopId wins over the cab's current loop (uploads are batched, so the
// cab may have changed loop since the entry was written).

import { playbackLogEntrySchema, type PlaybackLogEntryInput } from "@orison/shared";
import type { ZodIssue } from "zod";

export type RejectedEntry = { index: number; reason: string };
export type ValidEntry = { index: number; entry: PlaybackLogEntryInput };

const JOURNEY_EVENTS = new Set(["JOURNEY_START", "JOURNEY_END"]);

function describeIssue(issue: ZodIssue) {
  const field = issue.path.length > 0 ? issue.path.join(".") : "entry";
  return `${field}: ${issue.message}`.slice(0, 200);
}

export function validatePlaybackEntries(entries: unknown[]) {
  const valid: ValidEntry[] = [];
  const rejected: RejectedEntry[] = [];
  entries.forEach((raw, index) => {
    const result = playbackLogEntrySchema.safeParse(raw);
    if (result.success) {
      valid.push({ index, entry: result.data });
    } else {
      rejected.push({ index, reason: result.error.issues.slice(0, 3).map(describeIssue).join("; ") });
    }
  });
  return { valid, rejected };
}

/**
 * Drop entries already stored (eventId in `storedEventIds`) and repeats within the batch.
 * Entries without an eventId (firmware before 1.2.0) cannot be recognised and are always kept.
 */
export function skipDuplicateEntries(valid: ValidEntry[], storedEventIds: ReadonlySet<string>) {
  const seen = new Set<string>();
  const fresh: ValidEntry[] = [];
  let duplicates = 0;
  for (const item of valid) {
    const eventId = item.entry.eventId;
    if (eventId) {
      if (storedEventIds.has(eventId) || seen.has(eventId)) {
        duplicates += 1;
        continue;
      }
      seen.add(eventId);
    }
    fresh.push(item);
  }
  return { fresh, duplicates };
}

/** eventIds in a batch and the playedAt range they span (bounds the duplicate lookup). */
export function eventIdLookup(valid: ValidEntry[]) {
  const withId = valid.filter((item) => item.entry.eventId);
  if (withId.length === 0) {
    return null;
  }
  const times = withId.map((item) => new Date(item.entry.playedAt).getTime());
  return {
    eventIds: withId.map((item) => item.entry.eventId!),
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
  };
}

export type PlaybackRowContext = {
  deviceId: string;
  serialNumber: string;
  currentLoopId: string | null;
};

export function toPlaybackRow(entry: PlaybackLogEntryInput, context: PlaybackRowContext) {
  const event = entry.event ?? null;
  return {
    deviceId: context.deviceId,
    deviceSerial: entry.deviceSerial ?? context.serialNumber,
    loopId: entry.loopId ?? context.currentLoopId ?? "unknown",
    slotPosition: entry.slotPosition ?? null,
    contentType: entry.contentType ?? null,
    assetId: entry.assetId ?? null,
    playbackType: entry.type ?? null,
    eventName: event,
    mode: entry.mode ?? null,
    playerState: entry.state ?? null,
    playedAt: new Date(entry.playedAt),
    completedFull: entry.completedFull,
    durationMs: entry.durationMs ?? null,
    journeyId: entry.journeyId ?? null,
    eventId: entry.eventId ?? null,
    // Where a journey started and ended is useful; a copy of the same position on every play is not.
    locationData: event && JOURNEY_EVENTS.has(event) && entry.location ? entry.location : undefined,
  };
}
