import { type NextRequest } from "next/server";

import { deviceManifestResponseSchema } from "@orison/shared";

import { requireDevice } from "@/lib/device-auth";
import { getFleetControlState } from "@/lib/fleet-control";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { getPublishedLoopRoutingSnapshot, resolveExpectedLoopForGroup } from "@/lib/loop-routing";
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

    const [device, routing, fleetControl] = await Promise.all([
      requireDevice(request, serialNumber),
      getPublishedLoopRoutingSnapshot(),
      getFleetControlState(),
    ]);

    const loop = resolveExpectedLoopForGroup(device.groupId, routing);

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
        disabled: device.isDisabled || fleetControl.disabled,
        disabledReason: device.isDisabled ? device.disabledReason : fleetControl.reason,
      }),
    );
  } catch (error) {
    return apiError(error);
  }
}
