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

function normalizePlayerStatus(status: string | null | undefined) {
  switch (status) {
    case "playing":
      return "journey";
    case "silent":
      return "silent";
    case "disabled":
      return "disabled";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

export async function getDashboardData() {
  try {
    const now = new Date();
    const dayStart = startOfDay(now);
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const monthStart = startOfMonth(now);
    const rollingStart = subDays(now, 29);
    const [routing, fleetControl, settings, devices, groups, activity, publishingLoops, playbackLogs] =
      await Promise.all([
        getPublishedLoopRoutingSnapshot(),
        getFleetControlState(),
        getCmsSettings(),
        prisma.device.findMany({
          orderBy: { serialNumber: "asc" },
          select: {
            id: true,
            serialNumber: true,
            cabLicenseNumber: true,
            isActive: true,
            isDisabled: true,
            disabledReason: true,
            lastHeartbeatAt: true,
            lastSyncAt: true,
            currentLoopId: true,
            storageFreeMb: true,
            groupId: true,
            group: {
              select: {
                id: true,
                name: true,
              },
            },
            heartbeats: {
              orderBy: { receivedAt: "desc" },
              take: 1,
              select: {
                receivedAt: true,
                playerStatus: true,
                signalStrength: true,
              },
            },
          },
        }),
        prisma.deviceGroup.findMany({
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            description: true,
          },
        }),
        prisma.activityEvent.findMany({
          orderBy: { createdAt: "desc" },
          take: 14,
        }),
        prisma.loop.findMany({
          where: { status: "PUBLISHING" },
          orderBy: { updatedAt: "desc" },
          take: 4,
          select: {
            id: true,
            name: true,
            updatedAt: true,
            targetGroup: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
        prisma.playbackLog.findMany({
          where: {
            playedAt: {
              gte: rollingStart,
            },
          },
          select: {
            playedAt: true,
            eventName: true,
            contentType: true,
            durationMs: true,
          },
        }),
      ]);

    const safetyVideo = settings.safetyVideoAssetId
      ? await prisma.asset.findUnique({
          where: { id: settings.safetyVideoAssetId },
          select: {
            id: true,
            filename: true,
            durationMs: true,
          },
        })
      : null;

    const devicesWithExpectations = devices.map((device) => {
      const expectedLoop = resolveExpectedLoopForGroup(device.groupId, routing);
      const latestHeartbeat = device.heartbeats[0] ?? null;
      const playerStatus = normalizePlayerStatus(latestHeartbeat?.playerStatus);

      return {
        ...device,
        latestHeartbeat,
        expectedLoopId: expectedLoop?.id ?? null,
        expectedLoopName: expectedLoop?.name ?? null,
        status: resolveDeviceStatus(device, expectedLoop?.id ?? null),
        playerStatus,
      };
    });

    const statusCounts = devicesWithExpectations.reduce(
      (totals, device) => {
        totals.total += 1;
        totals[device.status] += 1;

        if (device.playerStatus === "journey") {
          totals.journey += 1;
        } else if (device.playerStatus === "silent") {
          totals.silent += 1;
        } else if (device.playerStatus === "idle") {
          totals.idle += 1;
        } else if (device.playerStatus === "disabled") {
          totals.disabledPlayer += 1;
        }

        return totals;
      },
      {
        total: 0,
        online: 0,
        outdated: 0,
        offline: 0,
        inactive: 0,
        journey: 0,
        silent: 0,
        idle: 0,
        disabledPlayer: 0,
      },
    );

    const advertisementLogs = playbackLogs.filter(
      (entry) => entry.contentType === "ADVERTISEMENT" && !entry.eventName,
    );
    const journeyStartLogs = playbackLogs.filter((entry) => entry.eventName === "JOURNEY_START");
    const journeyEndLogs = playbackLogs.filter((entry) => entry.eventName === "JOURNEY_END");
    const averageJourneyDurationMs =
      journeyEndLogs.length === 0
        ? 0
        : Math.round(
            journeyEndLogs.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0) / journeyEndLogs.length,
          );
    const adPlaysPerJourney =
      journeyStartLogs.length === 0
        ? 0
        : Number((advertisementLogs.length / journeyStartLogs.length).toFixed(1));

    const uptimePercent =
      devicesWithExpectations.length === 0
        ? 0
        : Math.round(((statusCounts.online + statusCounts.outdated) / devicesWithExpectations.length) * 100);

    const allFleetSummary = {
      id: "fleet-all",
      name: "All Fleet",
      description: "Full pilot fleet overview",
      deviceCount: devicesWithExpectations.length,
      onlineCount: statusCounts.online,
      outdatedCount: statusCounts.outdated,
      offlineCount: statusCounts.offline,
      disabledCount: devicesWithExpectations.filter((device) => device.isDisabled).length,
      journeyCount: statusCounts.journey,
      silentCount: statusCounts.silent,
      targetLoop: routing.fleetWideLoop,
      href: "/devices",
    };

    const groupSummaries = groups.map((group) => {
      const members = devicesWithExpectations.filter((device) => device.groupId === group.id);
      return {
        id: group.id,
        name: group.name,
        description: group.description,
        deviceCount: members.length,
        onlineCount: members.filter((device) => device.status === "online").length,
        outdatedCount: members.filter((device) => device.status === "outdated").length,
        offlineCount: members.filter((device) => device.status === "offline").length,
        disabledCount: members.filter((device) => device.isDisabled).length,
        journeyCount: members.filter((device) => device.playerStatus === "journey").length,
        silentCount: members.filter((device) => device.playerStatus === "silent").length,
        targetLoop: routing.groupLoops.get(group.id) ?? routing.fleetWideLoop,
        href: `/devices?group=${group.id}`,
      };
    });

    const activeProgrammes = [
      ...(routing.fleetWideLoop
        ? [
            {
              id: routing.fleetWideLoop.id,
              name: routing.fleetWideLoop.name,
              audience: "All devices",
              href: `/loops/${routing.fleetWideLoop.id}`,
              publishedAt: routing.fleetWideLoop.publishedAt,
            },
          ]
        : []),
      ...groups.flatMap((group) => {
        const groupLoop = routing.groupLoops.get(group.id);
        if (!groupLoop) {
          return [];
        }

        return [
          {
            id: groupLoop.id,
            name: groupLoop.name,
            audience: group.name,
            href: `/loops/${groupLoop.id}`,
            publishedAt: groupLoop.publishedAt,
          },
        ];
      }),
    ].sort((left, right) => {
      const leftTime = left.publishedAt ? left.publishedAt.getTime() : 0;
      const rightTime = right.publishedAt ? right.publishedAt.getTime() : 0;
      return rightTime - leftTime;
    });

    const attentionItems: Array<{
      id: string;
      severity: "critical" | "warning" | "info";
      title: string;
      detail: string;
      href: string;
      actionLabel: string;
    }> = [];

    if (fleetControl.disabled) {
      attentionItems.push({
        id: "fleet-disabled",
        severity: "critical",
        title: "Fleet kill-switch is active",
        detail: fleetControl.reason ?? "All devices are remotely disabled.",
        href: "/devices",
        actionLabel: "Review fleet controls",
      });
    }

    if (!safetyVideo) {
      attentionItems.push({
        id: "missing-safety",
        severity: "warning",
        title: "Safety video is not configured",
        detail: "Journeys can start without a mandatory safety message until one is selected in Settings.",
        href: "/settings",
        actionLabel: "Configure safety video",
      });
    }

    if (activeProgrammes.length === 0) {
      attentionItems.push({
        id: "no-live-programmes",
        severity: "warning",
        title: "No published programmes are live",
        detail: "Publish a fleet-wide loop or a group-targeted loop to resume playback.",
        href: "/loops",
        actionLabel: "Open loops",
      });
    }

    for (const loop of publishingLoops) {
      attentionItems.push({
        id: `publishing-${loop.id}`,
        severity: "info",
        title: `${loop.name} is publishing`,
        detail: `Currently compiling for ${loop.targetGroup?.name ?? "all devices"}.`,
        href: `/loops/${loop.id}`,
        actionLabel: "Open loop",
      });
    }

    for (const device of devicesWithExpectations.filter((item) => item.status === "offline").slice(0, 3)) {
      attentionItems.push({
        id: `offline-${device.id}`,
        severity: "critical",
        title: `${device.serialNumber} is offline`,
        detail: `Last heartbeat ${device.lastHeartbeatAt ? device.lastHeartbeatAt.toISOString() : "never received"}.`,
        href: "/devices",
        actionLabel: "Inspect device",
      });
    }

    for (const device of devicesWithExpectations.filter((item) => item.status === "outdated").slice(0, 3)) {
      attentionItems.push({
        id: `outdated-${device.id}`,
        severity: "warning",
        title: `${device.serialNumber} is on old content`,
        detail: `Expected ${device.expectedLoopName ?? "a published loop"} but device reports ${device.currentLoopId ?? "no loop"}.`,
        href: "/devices",
        actionLabel: "Check sync status",
      });
    }

    const lowStorageDevice = devicesWithExpectations.find(
      (device) => typeof device.storageFreeMb === "number" && device.storageFreeMb < 1024,
    );
    if (lowStorageDevice) {
      attentionItems.push({
        id: `storage-${lowStorageDevice.id}`,
        severity: "warning",
        title: `${lowStorageDevice.serialNumber} is low on storage`,
        detail: `${lowStorageDevice.storageFreeMb} MB remaining on device storage.`,
        href: "/devices",
        actionLabel: "Review device",
      });
    }

    const unassignedDevices = devicesWithExpectations.filter((device) => !device.groupId && device.isActive).length;
    if (groups.length > 0 && unassignedDevices > 0) {
      attentionItems.push({
        id: "unassigned-group-devices",
        severity: "info",
        title: `${unassignedDevices} devices are not assigned to a group`,
        detail: "They will receive the fleet-wide fallback loop until grouped.",
        href: "/devices",
        actionLabel: "Assign groups",
      });
    }

    return {
      devices: devicesWithExpectations,
      publishedLoop: routing.latestPublishedLoop,
      fleetWideLoop: routing.fleetWideLoop,
      safetyVideo,
      fleetControl,
      activity,
      activeProgrammes,
      publishingLoops,
      attentionItems: attentionItems.slice(0, 8),
      groupSummaries: [allFleetSummary, ...groupSummaries],
      stats: {
        totalDevices: statusCounts.total,
        onlineCount: statusCounts.online,
        outdatedCount: statusCounts.outdated,
        offlineCount: statusCounts.offline,
        disabledCount: devicesWithExpectations.filter((device) => device.isDisabled).length,
        activeJourneys: statusCounts.journey + statusCounts.silent,
        silentScreens: statusCounts.silent,
        idleScreens: statusCounts.idle,
        liveProgrammes: activeProgrammes.length,
        journeysToday: journeyStartLogs.filter((entry) => entry.playedAt >= dayStart).length,
        adPlaysToday: advertisementLogs.filter((entry) => entry.playedAt >= dayStart).length,
        uptimePercent,
      },
      journeyMetrics: {
        todayCount: journeyStartLogs.filter((entry) => entry.playedAt >= dayStart).length,
        weekCount: journeyStartLogs.filter((entry) => entry.playedAt >= weekStart).length,
        monthCount: journeyStartLogs.filter((entry) => entry.playedAt >= monthStart).length,
        averageDurationMs: averageJourneyDurationMs,
        adPlaysPerJourney,
      },
      error: null,
    };
  } catch (error) {
    return {
      devices: [],
      publishedLoop: null,
      fleetWideLoop: null,
      safetyVideo: null,
      fleetControl: {
        disabled: false,
        reason: null,
      },
      activity: [],
      activeProgrammes: [],
      publishingLoops: [],
      attentionItems: [],
      groupSummaries: [],
      stats: {
        totalDevices: 0,
        onlineCount: 0,
        outdatedCount: 0,
        offlineCount: 0,
        disabledCount: 0,
        activeJourneys: 0,
        silentScreens: 0,
        idleScreens: 0,
        liveProgrammes: 0,
        journeysToday: 0,
        adPlaysToday: 0,
        uptimePercent: 0,
      },
      journeyMetrics: {
        todayCount: 0,
        weekCount: 0,
        monthCount: 0,
        averageDurationMs: 0,
        adPlaysPerJourney: 0,
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
