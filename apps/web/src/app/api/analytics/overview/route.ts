import { prisma } from "@orison/db";
import { subDays } from "date-fns";

import { getCmsSettings } from "@/lib/cms-settings";
import { isDeviceOnline, offlineThresholdMs } from "@/lib/device-status";
import { apiError, apiResponse } from "@/lib/http";

export async function GET() {
  try {
    const since = subDays(new Date(), 30);
    const settings = await getCmsSettings();
    const thresholdMs = offlineThresholdMs(settings.heartbeatIntervalSeconds);
    const [devices, currentLoop, impressions] = await Promise.all([
      prisma.device.findMany(),
      prisma.loop.findFirst({
        where: { status: "PUBLISHED" },
        orderBy: { publishedAt: "desc" },
      }),
      prisma.playbackLog.count({
        where: {
          playedAt: {
            gte: since,
          },
        },
      }),
    ]);

    const onlineCount = devices.filter(
      (device) => device.isActive && isDeviceOnline(device.lastHeartbeatAt, thresholdMs),
    ).length;

    return apiResponse({
      totalDevices: devices.length,
      onlineCount,
      offlineCount: devices.length - onlineCount,
      currentLoop,
      impressions30Days: impressions,
    });
  } catch (error) {
    return apiError(error);
  }
}

