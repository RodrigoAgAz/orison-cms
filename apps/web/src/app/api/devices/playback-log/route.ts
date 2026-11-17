import { type NextRequest } from "next/server";

import { prisma, type Prisma } from "@orison/db";
import { playbackLogBatchSchema } from "@orison/shared";

import { requireDevice } from "@/lib/device-auth";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import {
  eventIdLookup,
  skipDuplicateEntries,
  toPlaybackRow,
  validatePlaybackEntries,
} from "@/lib/playback-ingest";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";

/**
 * Stores a batch of playback-log entries (DEVICE_CONTRACT_V2). 200 whenever the batch itself is
 * well formed, with what happened to each entry; the cab then drops everything it sent, so a bad
 * entry can never block the log or be re-sent forever. Firmware 1.0.0/1.1.0 only looks at the
 * status code.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request, playbackLogBatchSchema);
    enforceDeviceRateLimit(request, "device-playback-log", body.serialNumber, {
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
    const device = await requireDevice(request, body.serialNumber);

    const { valid, rejected } = validatePlaybackEntries(body.logs);
    const lookup = eventIdLookup(valid);

    const { accepted, duplicates } = await prisma.$transaction(async (tx) => {
      // One upload per cab at a time, so a batch re-sent while the first copy is still being
      // stored cannot slip past the duplicate check (no unique constraint: see the schema).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`playback-log:${device.id}`}))`;
      const stored = lookup
        ? await tx.playbackLog.findMany({
            where: {
              deviceId: device.id,
              playedAt: { gte: lookup.from, lte: lookup.to },
              eventId: { in: lookup.eventIds },
            },
            select: { eventId: true },
          })
        : [];
      const { fresh, duplicates: skipped } = skipDuplicateEntries(
        valid,
        new Set(stored.map((row) => row.eventId!).filter(Boolean)),
      );
      if (fresh.length > 0) {
        await tx.playbackLog.createMany({
          data: fresh.map(({ entry }) =>
            toPlaybackRow(entry, {
              deviceId: device.id,
              serialNumber: body.serialNumber,
              currentLoopId: device.currentLoopId,
            }),
          ) as Prisma.PlaybackLogCreateManyInput[],
        });
      }
      return { accepted: fresh.length, duplicates: skipped };
    });

    if (rejected.length > 0) {
      console.warn(
        `playback-log ${body.serialNumber}: ${rejected.length} of ${body.logs.length} entries rejected`,
        rejected.slice(0, 5),
      );
    }

    return apiResponse({
      ok: true,
      // "count" is what servers before DEVICE_CONTRACT_V2 returned (entries received).
      count: body.logs.length,
      accepted,
      duplicates,
      rejected,
    });
  } catch (error) {
    return apiError(error);
  }
}
