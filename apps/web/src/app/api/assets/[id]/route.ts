import { prisma } from "@orison/db";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { removeAssetFromLibrary } from "@/lib/asset-removal";
import { toApiError } from "@/lib/loop-api";

type Props = {
  params: {
    id: string;
  };
};

export async function GET(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const asset = await prisma.asset.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        filename: true,
        status: true,
        errorMessage: true,
        durationMs: true,
        width: true,
        height: true,
        s3Key: true,
        thumbnailKey: true,
        hiddenAt: true,
        slotPlacements: { select: { slot: { select: { loop: { select: { id: true, name: true, status: true } } } } } },
        staticSlots: { select: { loop: { select: { id: true, name: true, status: true } } } },
      },
    });

    if (!asset) {
      throw new ApiError("Asset not found", 404);
    }

    return apiResponse(asset);
  } catch (error) {
    return apiError(toApiError(error));
  }
}

/**
 * Remove an asset from the library. Deleted (row and files) when nothing uses it; otherwise
 * hidden from the library and kept for the loops that use it. The answer says which.
 */
export async function DELETE(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    return apiResponse(await removeAssetFromLibrary(params.id));
  } catch (error) {
    return apiError(toApiError(error));
  }
}
