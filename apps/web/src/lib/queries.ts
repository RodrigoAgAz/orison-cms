import { prisma, type Prisma } from "@orison/db";
import { defaultFillerTemplate, type AssetCategory } from "@orison/shared/src/constants";

import { getCmsSettings } from "./cms-settings";

// Dashboard, cabs, analytics and device-preview data live in lib/fleet-data.ts.

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
    safetyMessageDurationSeconds: 8,
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
          mimeType: true,
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
