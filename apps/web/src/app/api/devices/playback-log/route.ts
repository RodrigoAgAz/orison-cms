import { type NextRequest } from "next/server";

import { prisma } from "@orison/db";
import { playbackLogBatchSchema } from "@orison/shared";

import { requireDevice } from "@/lib/device-auth";
import { apiError, apiResponse } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const body = playbackLogBatchSchema.parse(await request.json());
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

