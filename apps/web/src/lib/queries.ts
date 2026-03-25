import { eachDayOfInterval, format, subDays } from "date-fns";

import { prisma } from "@orison/db";

import { getCmsSettings } from "./cms-settings";
import { getPublicUrl } from "./storage";

export function resolveDeviceStatus(device: {
  isActive: boolean;
  lastHeartbeatAt: Date | null;
  currentLoopId: string | null;
}, publishedLoopId: string | null) {
  if (!device.isActive) {
    return "inactive";
  }

  if (!device.lastHeartbeatAt || device.lastHeartbeatAt < new Date(Date.now() - 60 * 60 * 1000)) {
    return "offline";
  }

  if (publishedLoopId && device.currentLoopId !== publishedLoopId) {
    return "outdated";
  }

  return "online";
}

export async function getDashboardData() {
  try {
    const since = subDays(new Date(), 1);
    const [devices, publishedLoop, activity, impressionsToday] = await Promise.all([
      prisma.device.findMany({
        orderBy: { serialNumber: "asc" },
      }),
      prisma.loop.findFirst({
        where: { status: "PUBLISHED" },
        orderBy: { publishedAt: "desc" },
      }),
      prisma.activityEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
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

    const uptimePercent =
      devices.length === 0 ? 0 : Math.round((onlineCount / devices.length) * 100);

    return {
      devices,
      publishedLoop,
      activity,
      stats: {
        totalDevices: devices.length,
        onlineCount,
        offlineCount: devices.length - onlineCount,
        impressionsToday,
        uptimePercent,
      },
    };
  } catch (error) {
    console.error(error);
    return {
      devices: [],
      publishedLoop: null,
      activity: [],
      stats: {
        totalDevices: 0,
        onlineCount: 0,
        offlineCount: 0,
        impressionsToday: 0,
        uptimePercent: 0,
      },
    };
  }
}

export async function getCurrentPublishedLoop() {
  try {
    const loop = await prisma.loop.findFirst({
      where: {
        status: "PUBLISHED",
        OR: [{ compiledVideoUrl: { not: null } }, { compiledVideoKey: { not: null } }],
      },
      orderBy: { publishedAt: "desc" },
      select: {
        id: true,
        name: true,
        compiledVideoUrl: true,
        compiledVideoKey: true,
        publishedAt: true,
        checksum: true,
        updatedAt: true,
      },
    });

    if (!loop) {
      return null;
    }

    return {
      ...loop,
      compiledVideoUrl:
        loop.compiledVideoUrl ?? (loop.compiledVideoKey ? getPublicUrl(loop.compiledVideoKey) : null),
    };
  } catch (error) {
    console.error(error);
    return null;
  }
}

export async function getLoopListData() {
  try {
    return await prisma.loop.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        slots: {
          include: {
            contents: true,
          },
        },
      },
    });
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function getLoopBuilderData(loopId: string) {
  try {
    const [loop, advertisementAssets, fillerAssets, settings] = await Promise.all([
      prisma.loop.findUnique({
        where: { id: loopId },
        include: {
          slots: {
            orderBy: { position: "asc" },
            include: {
              contents: {
                orderBy: { orderInSlot: "asc" },
                include: {
                  asset: true,
                },
              },
            },
          },
        },
      }),
      prisma.asset.findMany({
        where: {
          category: "ADVERTISEMENT",
          status: "READY",
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.asset.findMany({
        where: {
          category: {
            in: ["FILLER_WEATHER", "FILLER_NEWS", "FILLER_BRANDED", "FILLER_OTHER"],
          },
          status: "READY",
        },
        orderBy: { createdAt: "desc" },
      }),
      getCmsSettings(),
    ]);

    return {
      loop,
      advertisementAssets,
      fillerAssets,
      settings,
    };
  } catch (error) {
    console.error(error);
    return {
      loop: null,
      advertisementAssets: [],
      fillerAssets: [],
      settings: {
        defaultFillerTemplate: [],
        syncIntervalSeconds: 1800,
        heartbeatIntervalSeconds: 300,
        notificationEmails: [],
      },
    };
  }
}

export async function getAssetLibraryData() {
  try {
    return prisma.asset.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        slotPlacements: {
          include: {
            slot: {
              include: {
                loop: true,
              },
            },
          },
        },
      },
    });
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function getDevicesData() {
  try {
    const publishedLoop = await prisma.loop.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
    });

    const devices = await prisma.device.findMany({
      orderBy: { serialNumber: "asc" },
      include: {
        heartbeats: {
          orderBy: { receivedAt: "desc" },
          take: 6,
        },
      },
    });

    return {
      devices,
      publishedLoopId: publishedLoop?.id ?? null,
    };
  } catch (error) {
    console.error(error);
    return {
      devices: [],
      publishedLoopId: null,
    };
  }
}

export async function getAnalyticsData() {
  try {
    const today = new Date();
    const start = subDays(today, 29);
    const [dailyLogs, adCounts, deviceCount, onlineDevices] = await Promise.all([
      prisma.playbackLog.findMany({
        where: {
          playedAt: {
            gte: start,
          },
        },
        select: {
          playedAt: true,
        },
      }),
      prisma.playbackLog.groupBy({
        by: ["assetId"],
        where: {
          contentType: "ADVERTISEMENT",
          playedAt: {
            gte: start,
          },
        },
        _count: true,
      }),
      prisma.device.count({
        where: { isActive: true },
      }),
      prisma.device.count({
        where: {
          isActive: true,
          lastHeartbeatAt: {
            gte: new Date(Date.now() - 60 * 60 * 1000),
          },
        },
      }),
    ]);

    const assetIds = adCounts
      .map((item) => item.assetId)
      .filter((assetId): assetId is string => Boolean(assetId));

    const assets = assetIds.length
      ? await prisma.asset.findMany({
          where: { id: { in: assetIds } },
        })
      : [];

    const assetMap = new Map(assets.map((asset) => [asset.id, asset.filename]));
    const impressionsByDay = new Map<string, number>();

    for (const entry of dailyLogs) {
      const day = entry.playedAt.toISOString().slice(0, 10);
      impressionsByDay.set(day, (impressionsByDay.get(day) ?? 0) + 1);
    }

    return {
      impressionsSeries: eachDayOfInterval({
        start,
        end: today,
      }).map((day) => {
        const key = format(day, "yyyy-MM-dd");
        return {
          day: key,
          count: impressionsByDay.get(key) ?? 0,
        };
      }),
      adBreakdown: adCounts.map((entry) => ({
        assetId: entry.assetId,
        label: entry.assetId ? assetMap.get(entry.assetId) ?? entry.assetId : "Unknown",
        count: entry._count,
      })),
      fleetUptimePercent: deviceCount === 0 ? 0 : Math.round((onlineDevices / deviceCount) * 100),
    };
  } catch (error) {
    console.error(error);
    return {
      impressionsSeries: [],
      adBreakdown: [],
      fleetUptimePercent: 0,
    };
  }
}

export async function getSettingsData() {
  try {
    const [settings, users] = await Promise.all([
      getCmsSettings(),
      prisma.user.findMany({
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return {
      settings,
      users,
    };
  } catch (error) {
    console.error(error);
    return {
      settings: {
        defaultFillerTemplate: [],
        syncIntervalSeconds: 1800,
        heartbeatIntervalSeconds: 300,
        notificationEmails: [],
      },
      users: [],
    };
  }
}
