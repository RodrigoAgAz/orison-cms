import { prisma } from "@orison/db";
import { subDays } from "date-fns";

import { requireApiUser } from "@/lib/auth";
import { getCmsSettings } from "@/lib/cms-settings";
import { isDeviceOnline, offlineThresholdMs } from "@/lib/device-status";
import { getLoopRoutingSnapshot, resolveFleetLoop } from "@/lib/loop-routing";
import { apiError, apiResponse } from "@/lib/http";

export async function GET() {
  try {
    await requireApiUser();
    const since = subDays(new Date(), 30);
    const settings = await getCmsSettings();
    const thresholdMs = offlineThresholdMs(settings.heartbeatIntervalSeconds);
    const [devices, currentLoop, impressions] = await Promise.all([
      prisma.device.findMany(),
      // The loop the fleet is set to play (same resolver as the device manifest route).
      getLoopRoutingSnapshot().then((snapshot) => {
        const fleetLoop = resolveFleetLoop(snapshot);
        return fleetLoop ? prisma.loop.findUnique({ where: { id: fleetLoop.id } }) : null;
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

