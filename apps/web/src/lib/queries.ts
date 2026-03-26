import { eachDayOfInterval, format, startOfDay, startOfMonth, startOfWeek, subDays } from "date-fns";

import { prisma, type Prisma } from "@orison/db";
import { defaultFillerTemplate, type AssetCategory } from "@orison/shared/src/constants";

import { getCmsSettings } from "./cms-settings";
import { getFleetControlState } from "./fleet-control";
import { getPublishedLoopRoutingSnapshot, resolveExpectedLoopForGroup } from "./loop-routing";
import { getPublicUrl } from "./storage";

function formatQueryFailure(scope: string, error: unknown) {
  console.error(error);
  return `${scope} could not be loaded. Check the server logs and refresh.`;
}

function buildDefaultSettings() {
  return {
    defaultFillerTemplate: [...defaultFillerTemplate],
    syncIntervalSeconds: 1800,
    heartbeatIntervalSeconds: 300,
    notificationEmails: [],
    safetyVideoAssetId: null,
  };
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

export function resolveDeviceStatus(
  device: {
    isActive: boolean;
    lastHeartbeatAt: Date | null;
    currentLoopId: string | null;
  },
  expectedLoopId: string | null,
) {
  if (!device.isActive) {
    return "inactive";
  }

  if (!device.lastHeartbeatAt || device.lastHeartbeatAt < new Date(Date.now() - 60 * 60 * 1000)) {
    return "offline";
  }

  if (expectedLoopId && device.currentLoopId !== expectedLoopId) {
    return "outdated";
  }

  return "online";
}

export async function getDashboardData() {
  try {
    const since = subDays(new Date(), 1);
    const [devices, routing, activity, impressionsToday] = await Promise.all([
      prisma.device.findMany({
        orderBy: { serialNumber: "asc" },
        select: {
          id: true,
          serialNumber: true,
          cabLicenseNumber: true,
          isActive: true,
          lastHeartbeatAt: true,
          currentLoopId: true,
          groupId: true,
          isDisabled: true,
        },
      }),
      getPublishedLoopRoutingSnapshot(),
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

    const devicesWithExpectations = devices.map((device) => ({
      ...device,
      expectedLoopId: resolveExpectedLoopForGroup(device.groupId, routing)?.id ?? null,
    }));

    const onlineCount = devicesWithExpectations.filter(
      (device) =>
        device.lastHeartbeatAt &&
        device.lastHeartbeatAt > new Date(Date.now() - 60 * 60 * 1000) &&
        device.isActive,
    ).length;

    const uptimePercent =
      devicesWithExpectations.length === 0 ? 0 : Math.round((onlineCount / devicesWithExpectations.length) * 100);

    return {
      devices: devicesWithExpectations,
      publishedLoop: routing.latestPublishedLoop,
      activity,
      stats: {
        totalDevices: devicesWithExpectations.length,
        onlineCount,
        offlineCount: devicesWithExpectations.length - onlineCount,
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
          targetGroupId: true,
          targetGroup: {
            select: {
              id: true,
              name: true,
            },
          },
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
    const [loop, advertisementAssets, staticCreativeAssets, fillerAssets, settings, deviceGroups] =
      await Promise.all([
        prisma.loop.findUnique({
          where: { id: loopId },
          include: {
            targetGroup: {
              select: {
                id: true,
                name: true,
              },
            },
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
        prisma.deviceGroup.findMany({
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
          },
        }),
      ]);

    return {
      loop,
      advertisementAssets,
      staticCreativeAssets,
      fillerAssets,
      deviceGroups,
      settings,
      error: null,
    };
  } catch (error) {
    return {
      loop: null,
      advertisementAssets: [],
      staticCreativeAssets: [],
      fillerAssets: [],
      deviceGroups: [],
      settings: buildDefaultSettings(),
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

    const [items, total] = (await Promise.all([
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
    ])) as [AssetLibraryItem[], number];

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
  groupId,
}: {
  page?: number;
  pageSize?: number;
  groupId?: string | null;
} = {}) {
  try {
    const filterGroupId = groupId && groupId !== "ALL" ? groupId : null;
    const [routing, groups, devices, total, fleetControl] = await Promise.all([
      getPublishedLoopRoutingSnapshot(),
      prisma.deviceGroup.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          _count: {
            select: {
              devices: true,
            },
          },
        },
      }),
      prisma.device.findMany({
        where: filterGroupId ? { groupId: filterGroupId } : undefined,
        orderBy: { serialNumber: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          group: {
            select: {
              id: true,
              name: true,
            },
          },
          heartbeats: {
            orderBy: { receivedAt: "desc" },
            take: 6,
          },
        },
      }),
      prisma.device.count({
        where: filterGroupId ? { groupId: filterGroupId } : undefined,
      }),
      getFleetControlState(),
    ]);

    return {
      devices: devices.map((device) => ({
        ...device,
        expectedLoopId: resolveExpectedLoopForGroup(device.groupId, routing)?.id ?? null,
      })),
      groups,
      total,
      page,
      pageSize,
      selectedGroupId: filterGroupId ?? "ALL",
      publishedLoopId: routing.latestPublishedLoop?.id ?? null,
      fleetControl,
      error: null,
    };
  } catch (error) {
    return {
      devices: [],
      groups: [],
      total: 0,
      page,
      pageSize,
      selectedGroupId: groupId ?? "ALL",
      publishedLoopId: null,
      fleetControl: {
        disabled: false,
        reason: null,
      },
      error: formatQueryFailure("Device registry", error),
    };
  }
}

export async function getAnalyticsData() {
  try {
    const today = new Date();
    const start = subDays(today, 29);
    const todayStart = startOfDay(today);
    const weekStart = startOfWeek(today, { weekStartsOn: 1 });
    const monthStart = startOfMonth(today);
    const [dailyLogs, deviceCount, onlineDevices, deviceLocations] = await Promise.all([
      prisma.playbackLog.findMany({
        where: {
          playedAt: {
            gte: start,
          },
        },
        select: {
          playedAt: true,
          assetId: true,
          contentType: true,
          completedFull: true,
          durationMs: true,
          journeyId: true,
          eventName: true,
        },
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
      prisma.device.findMany({
        where: { isActive: true },
        orderBy: { serialNumber: "asc" },
        select: {
          serialNumber: true,
          heartbeats: {
            orderBy: { receivedAt: "desc" },
            take: 1,
            select: {
              receivedAt: true,
              locationData: true,
            },
          },
        },
      }),
    ]);

    const advertisementLogs = dailyLogs.filter(
      (log) => log.contentType === "ADVERTISEMENT" && !log.eventName,
    );
    const journeyStartLogs = dailyLogs.filter((log) => log.eventName === "JOURNEY_START");
    const journeyEndLogs = dailyLogs.filter((log) => log.eventName === "JOURNEY_END");
    const assetIds = advertisementLogs
      .map((item) => item.assetId)
      .filter((assetId): assetId is string => Boolean(assetId));

    const assets = assetIds.length
      ? await prisma.asset.findMany({
          where: { id: { in: assetIds } },
        })
      : [];

    const assetMap = new Map(assets.map((asset) => [asset.id, asset.filename]));
    const impressionsByDay = new Map<string, number>();
    const adAggregation = new Map<
      string,
      {
        count: number;
        completed: number;
      }
    >();

    for (const entry of dailyLogs) {
      const day = entry.playedAt.toISOString().slice(0, 10);
      impressionsByDay.set(day, (impressionsByDay.get(day) ?? 0) + 1);
    }

    for (const entry of advertisementLogs) {
      if (!entry.assetId) {
        continue;
      }

      const current = adAggregation.get(entry.assetId) ?? { count: 0, completed: 0 };
      current.count += 1;
      if (entry.completedFull) {
        current.completed += 1;
      }
      adAggregation.set(entry.assetId, current);
    }

    const averageJourneyDurationMs =
      journeyEndLogs.length === 0
        ? 0
        : Math.round(
            journeyEndLogs.reduce((sum, log) => sum + (log.durationMs ?? 0), 0) / journeyEndLogs.length,
          );
    const adPlaysPerJourney =
      journeyStartLogs.length === 0
        ? 0
        : Number((advertisementLogs.length / journeyStartLogs.length).toFixed(1));

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
      adBreakdown: Array.from(adAggregation.entries()).map(([assetId, totals]) => ({
        assetId,
        label: assetMap.get(assetId) ?? assetId,
        count: totals.count,
        completionRate: totals.count === 0 ? 0 : Math.round((totals.completed / totals.count) * 100),
      })),
      fleetUptimePercent: deviceCount === 0 ? 0 : Math.round((onlineDevices / deviceCount) * 100),
      journeyMetrics: {
        todayCount: journeyStartLogs.filter((log) => log.playedAt >= todayStart).length,
        weekCount: journeyStartLogs.filter((log) => log.playedAt >= weekStart).length,
        monthCount: journeyStartLogs.filter((log) => log.playedAt >= monthStart).length,
        averageDurationMs: averageJourneyDurationMs,
        adPlaysPerJourney,
      },
      deviceLocations: deviceLocations.map((device) => ({
        serialNumber: device.serialNumber,
        lastHeartbeatAt: device.heartbeats[0]?.receivedAt?.toISOString() ?? null,
        locationData: device.heartbeats[0]?.locationData ?? null,
      })),
      error: null,
    };
  } catch (error) {
    return {
      impressionsSeries: [],
      adBreakdown: [],
      fleetUptimePercent: 0,
      journeyMetrics: {
        todayCount: 0,
        weekCount: 0,
        monthCount: 0,
        averageDurationMs: 0,
        adPlaysPerJourney: 0,
      },
      deviceLocations: [],
      error: formatQueryFailure("Analytics", error),
    };
  }
}

export async function getSettingsData() {
  try {
    const [settings, users, safetyAssets] = await Promise.all([
      getCmsSettings(),
      prisma.user.findMany({
        orderBy: { createdAt: "asc" },
      }),
      prisma.asset.findMany({
        where: {
          category: "SAFETY_MESSAGE",
          status: "READY",
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          filename: true,
          durationMs: true,
        },
      }),
    ]);

    return {
      settings,
      users,
      safetyAssets,
      error: null,
    };
  } catch (error) {
    return {
      settings: buildDefaultSettings(),
      users: [],
      safetyAssets: [],
      error: formatQueryFailure("Settings", error),
    };
  }
}
