import { type NextRequest } from "next/server";

import { prisma } from "@orison/db";
import { deviceManifestResponseSchema } from "@orison/shared";

import { requireDevice } from "@/lib/device-auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  try {
    const serialNumber = request.headers.get("x-device-serial");
    if (!serialNumber) {
      throw new ApiError("Missing X-Device-Serial header", 400);
    }

    enforceDeviceRateLimit(request, "device-manifest", serialNumber, {
      limit: 180,
      windowMs: 5 * 60 * 1000,
    });
    await requireDevice(request, serialNumber);

    const loop = await prisma.loop.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
    });

    if (!loop?.manifestUrl) {
      throw new ApiError("No published loop available", 404);
    }

    return apiResponse(
      deviceManifestResponseSchema.parse({
        loopId: loop.id,
        manifestUrl: loop.manifestUrl,
        version: loop.version,
        checksum: loop.checksum ?? "",
        compiledVideoUrl: loop.compiledVideoUrl,
      }),
    );
  } catch (error) {
    return apiError(error);
  }
}
