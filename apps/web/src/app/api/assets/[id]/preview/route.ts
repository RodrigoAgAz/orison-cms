import { prisma } from "@orison/db";
import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { apiError, ApiError } from "@/lib/http";
import { getSignedAssetUrl } from "@/lib/storage";

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
    });

    if (!asset) {
      throw new ApiError("Asset not found", 404);
    }

    const url = await getSignedAssetUrl(asset.s3Key);
    return NextResponse.redirect(url);
  } catch (error) {
    return apiError(error);
  }
}

