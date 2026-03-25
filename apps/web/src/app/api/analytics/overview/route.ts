import { prisma } from "@orison/db";
import { subDays } from "date-fns";

import { apiError, apiResponse } from "@/lib/http";

export async function GET() {
  try {
    const since = subDays(new Date(), 30);
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
      (device) =>
        device.lastHeartbeatAt &&
        device.lastHeartbeatAt > new Date(Date.now() - 60 * 60 * 1000) &&
        device.isActive,
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

