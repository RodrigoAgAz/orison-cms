import { eachDayOfInterval, format, subDays } from "date-fns";

import { prisma, type Prisma } from "@orison/db";
import type { AssetCategory } from "@orison/shared/src/constants";

import { getCmsSettings } from "./cms-settings";
import { getPublicUrl } from "./storage";

function formatQueryFailure(scope: string, error: unknown) {
  console.error(error);
  return `${scope} could not be loaded. Check the server logs and refresh.`;
}

type AssetLibraryItem = Prisma.AssetGetPayload<{
  select: {
    id: true;
    filename: true;
    category: true;
    status: true;
    mimeType: true;
    durationMs: true;
    width: true;
    height: true;
    fileSize: true;
    thumbnailKey: true;
    s3Key: true;
    metadata: true;
    createdAt: true;
    slotPlacements: {
      select: {
        slot: {
          select: {
            position: true;
            loop: {
              select: {
                id: true;
                name: true;
                status: true;
              };
            };
          };
        };
      };
    };
    staticSlots: {
      select: {
        position: true;
        loop: {
          select: {
            id: true;
            name: true;
            status: true;
          };
        };
      };
    };
  };
}>;

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
      error: null,
    };
  } catch (error) {
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
      error: formatQueryFailure("Dashboard data", error),
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

export async function getLoopListData({
  page = 1,
  pageSize = 12,
}: {
  page?: number;
  pageSize?: number;
} = {}) {
  try {
    const [items, total] = await Promise.all([
      prisma.loop.findMany({
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          status: true,
          updatedAt: true,
          compiledVideoUrl: true,
          compiledVideoKey: true,
          slots: {
            select: {
              id: true,
              contents: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      }),
      prisma.loop.count(),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      error: null,
    };
  } catch (error) {
    return {
      items: [],
      total: 0,
      page,
      pageSize,
      error: formatQueryFailure("Loop library", error),
    };
  }
}

export async function getLoopBuilderData(loopId: string) {
  try {
    const [loop, advertisementAssets, staticCreativeAssets, fillerAssets, settings] = await Promise.all([
      prisma.loop.findUnique({
        where: { id: loopId },
        include: {
          slots: {
            orderBy: { position: "asc" },
            include: {
              staticCreative: true,
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
          category: "STATIC_CREATIVE",
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
      staticCreativeAssets,
      fillerAssets,
      settings,
      error: null,
    };
  } catch (error) {
    return {
      loop: null,
      advertisementAssets: [],
      staticCreativeAssets: [],
      fillerAssets: [],
      settings: {
        defaultFillerTemplate: [],
        syncIntervalSeconds: 1800,
        heartbeatIntervalSeconds: 300,
        notificationEmails: [],
      },
      error: formatQueryFailure("Loop builder", error),
    };
  }
}

export async function getAssetLibraryData({
  page = 1,
  pageSize = 18,
  search,
  category,
}: {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: AssetCategory | "ALL";
} = {}) {
  try {
    const where: Prisma.AssetWhereInput = {
      ...(category && category !== "ALL" ? { category } : {}),
      ...(search
        ? {
            OR: [
              {
                filename: {
                  contains: search,
                  mode: "insensitive" as const,
                },
              },
              {
                metadata: {
                  path: ["advertiserName"],
                  string_contains: search,
                },
              },
              {
                metadata: {
                  path: ["campaignName"],
                  string_contains: search,
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          filename: true,
          category: true,
          status: true,
          mimeType: true,
          durationMs: true,
          width: true,
          height: true,
          fileSize: true,
          thumbnailKey: true,
          s3Key: true,
          metadata: true,
          createdAt: true,
          slotPlacements: {
            select: {
              slot: {
                select: {
                  position: true,
                  loop: {
                    select: {
                      id: true,
                      name: true,
                      status: true,
                    },
                  },
                },
              },
            },
          },
          staticSlots: {
            select: {
              position: true,
              loop: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                },
              },
            },
          },
        },
      }),
      prisma.asset.count({ where }),
    ]) as [AssetLibraryItem[], number];

    return {
      items,
      total,
      page,
      pageSize,
      search: search ?? "",
      category: category ?? "ALL",
      error: null,
    };
  } catch (error) {
    return {
      items: [] as AssetLibraryItem[],
      total: 0,
      page,
      pageSize,
      search: search ?? "",
      category: category ?? "ALL",
      error: formatQueryFailure("Asset library", error),
    };
  }
}

export async function getDevicesData({
  page = 1,
  pageSize = 12,
}: {
  page?: number;
  pageSize?: number;
} = {}) {
  try {
    const [publishedLoop, devices, total] = await Promise.all([
      prisma.loop.findFirst({
        where: { status: "PUBLISHED" },
        orderBy: { publishedAt: "desc" },
      }),
      prisma.device.findMany({
        orderBy: { serialNumber: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          heartbeats: {
            orderBy: { receivedAt: "desc" },
            take: 6,
          },
        },
      }),
      prisma.device.count(),
    ]);

    return {
      devices,
      total,
      page,
      pageSize,
      publishedLoopId: publishedLoop?.id ?? null,
      error: null,
    };
  } catch (error) {
    return {
      devices: [],
      total: 0,
      page,
      pageSize,
      publishedLoopId: null,
      error: formatQueryFailure("Device registry", error),
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
      error: null,
    };
  } catch (error) {
    return {
      impressionsSeries: [],
      adBreakdown: [],
      fleetUptimePercent: 0,
      error: formatQueryFailure("Analytics", error),
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
      error: null,
    };
  } catch (error) {
    return {
      settings: {
        defaultFillerTemplate: [],
        syncIntervalSeconds: 1800,
        heartbeatIntervalSeconds: 300,
        notificationEmails: [],
      },
      users: [],
      error: formatQueryFailure("Settings", error),
    };
  }
}
