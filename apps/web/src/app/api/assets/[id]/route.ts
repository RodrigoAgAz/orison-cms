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
      },
    });

    if (!asset) {
      throw new ApiError("Asset not found", 404);
    }

    const usedInPublishedLoop = asset.slotPlacements.some(
      (placement) => placement.slot.loop.status === "PUBLISHED",
    );

    if (usedInPublishedLoop) {
      throw new ApiError("Cannot delete an asset used by a published loop", 409);
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

