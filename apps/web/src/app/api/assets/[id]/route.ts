import { prisma } from "@orison/db";

import { apiError, apiResponse, ApiError } from "@/lib/http";
import { deleteObject } from "@/lib/storage";

type Props = {
  params: {
    id: string;
  };
};

export async function GET(_: Request, { params }: Props) {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        s3Key: true,
        thumbnailKey: true,
        slotPlacements: {
          select: {
            slot: {
              select: {
                loop: {
                  select: {
                    status: true,
                  },
                },
              },
            },
          },
        },
        staticSlots: {
          select: {
            loop: {
              select: {
                status: true,
              },
            },
          },
        },
      },
    });

    if (!asset) {
      throw new ApiError("Asset not found", 404);
    }

    return apiResponse(asset);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: params.id },
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
        staticSlots: {
          include: {
            loop: true,
          },
        },
      },
    });

    if (!asset) {
      throw new ApiError("Asset not found", 404);
    }

    const usedInPublishedLoop =
      asset.slotPlacements.some((placement) =>
        ["PUBLISHED", "PUBLISHING"].includes(placement.slot.loop.status),
      ) ||
      asset.staticSlots.some((slot) => ["PUBLISHED", "PUBLISHING"].includes(slot.loop.status));

    if (usedInPublishedLoop) {
      throw new ApiError("Cannot delete an asset used by a published or publishing loop", 409);
    }

    await prisma.asset.delete({
      where: { id: asset.id },
    });

    await deleteObject(asset.s3Key).catch(() => undefined);
    if (asset.thumbnailKey) {
      await deleteObject(asset.thumbnailKey).catch(() => undefined);
    }

    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
