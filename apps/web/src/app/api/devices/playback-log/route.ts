import { type NextRequest } from "next/server";

import { prisma } from "@orison/db";
import { playbackLogBatchSchema } from "@orison/shared";

import { requireDevice } from "@/lib/device-auth";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request, playbackLogBatchSchema);
    enforceDeviceRateLimit(request, "device-playback-log", body.serialNumber, {
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
    const device = await requireDevice(request, body.serialNumber);

    await prisma.playbackLog.createMany({
      data: body.logs.map((log) => ({
        deviceId: device.id,
        deviceSerial: log.deviceSerial ?? body.serialNumber,
        loopId: device.currentLoopId ?? "unknown",
        slotPosition: log.slotPosition ?? null,
        contentType: log.contentType ?? null,
        assetId: log.assetId,
        playbackType: log.type ?? null,
        eventName: log.event ?? null,
        mode: log.mode ?? null,
        playerState: log.state ?? null,
        playedAt: new Date(log.playedAt),
        completedFull: log.completedFull,
        durationMs: log.durationMs ?? null,
        journeyId: log.journeyId ?? null,
        locationData: log.location ?? undefined,
      })),
    });

    return apiResponse({ ok: true, count: body.logs.length });
  } catch (error) {
    return apiError(error);
  }
}
