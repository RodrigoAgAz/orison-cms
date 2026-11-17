import { type NextRequest } from "next/server";

import { deviceManifestResponseSchema } from "@orison/shared";

import { requireDevice } from "@/lib/device-auth";
import { env } from "@/lib/env";
import { getFleetControlState } from "@/lib/fleet-control";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { getLoopRoutingSnapshot, resolveDeviceLoop } from "@/lib/loop-routing";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";
import { resolveSafetyMessageForCabs } from "@/lib/safety-message";
import { rebaseStorageUrl, requestOrigin } from "@/lib/storage-urls";

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

    const [device, routing, fleetControl, safety] = await Promise.all([
      requireDevice(request, serialNumber),
      getLoopRoutingSnapshot(),
      getFleetControlState(),
      resolveSafetyMessageForCabs(),
    ]);

    const { loop } = resolveDeviceLoop(device, routing);

    if (!loop?.manifestUrl) {
      throw new ApiError("No published loop available", 404);
    }

    // Stored URLs carry the domain the loop was published under; serve them on the one the cab
    // is using now (lib/storage-urls.ts).
    const origin = requestOrigin(request, env.appUrl);

    return apiResponse(
      deviceManifestResponseSchema.parse({
        loopId: loop.id,
        manifestUrl: rebaseStorageUrl(loop.manifestUrl, origin),
        version: loop.version,
        checksum: loop.checksum ?? "",
        compiledVideoUrl: rebaseStorageUrl(loop.compiledVideoUrl, origin),
        disabled: device.isDisabled || fleetControl.disabled,
        disabledReason: device.isDisabled ? device.disabledReason : fleetControl.reason,
        // The safety message configured now, not the one frozen into the loop's manifest file
        // (firmware 1.2.0+ uses this; older firmware keeps reading the file's copy).
        // Key left out (no opinion) when the configured message cannot be served right now.
        ...(safety.state === "unusable"
          ? {}
          : {
              safetyVideo:
                safety.state === "ok"
                  ? {
                      url: rebaseStorageUrl(safety.message.url, origin),
                      checksum: safety.message.checksum ?? "",
                      durationMs: safety.message.durationMs,
                      mimeType: safety.message.mimeType,
                    }
                  : null,
            }),
      }),
    );
  } catch (error) {
    return apiError(error);
  }
}
