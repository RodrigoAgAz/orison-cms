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
        loopId: device.currentLoopId ?? "unknown",
        slotPosition: log.slotPosition,
        contentType: log.contentType,
        assetId: log.assetId,
        playedAt: new Date(log.playedAt),
        completedFull: log.completedFull,
      })),
    });

    return apiResponse({ ok: true, count: body.logs.length });
  } catch (error) {
    return apiError(error);
  }
}
