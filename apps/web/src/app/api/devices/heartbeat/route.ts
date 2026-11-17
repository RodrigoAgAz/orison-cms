import { type NextRequest } from "next/server";

import { prisma, type Prisma } from "@orison/db";
import { heartbeatSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { getCmsSettings } from "@/lib/cms-settings";
import { authenticateDeviceRequest } from "@/lib/device-auth";
import { applyHeartbeat } from "@/lib/device-heartbeat";
import { resolveHeartbeatLocation } from "@/lib/device-location";
import { getFleetControlState } from "@/lib/fleet-control";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import { getLoopRoutingSnapshot, resolveDeviceLoop } from "@/lib/loop-routing";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";
import { getConfiguredSafetyMessage } from "@/lib/safety-message";

// What firmware 1.2.0+ may adopt from the response (it clamps them itself as well).
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.round(value), min), max);
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request, heartbeatSchema);
    enforceDeviceRateLimit(request, "device-heartbeat", body.serialNumber, {
      limit: 120,
      windowMs: 5 * 60 * 1000,
    });
    const previous = await authenticateDeviceRequest(request, body.serialNumber, {
      allowUnregisteredSharedToken: true,
    });

    const now = new Date();
    // Never fails: GPS wins, otherwise the serving cell via cache/providers (short timeout).
    const [{ position, cell }, snapshot, fleetControl, settings] = await Promise.all([
      resolveHeartbeatLocation(body.location, now),
      getLoopRoutingSnapshot(),
      getFleetControlState(),
      getCmsSettings(),
    ]);
    const locationFields = position
      ? {
          locationLat: position.lat,
          locationLng: position.lng,
          locationAccuracyM: position.accuracyM,
          locationSource: position.source,
          locationAt: position.at,
        }
      : {};

    const reportedLoopId = body.currentLoopId ?? null;
    const reportedLoopName =
      reportedLoopId && (reportedLoopId !== previous?.currentLoopId || body.sync)
        ? snapshot.loops.get(reportedLoopId)?.name ??
          (await prisma.loop.findUnique({ where: { id: reportedLoopId }, select: { name: true } }))?.name ??
          null
        : null;
    const { fields, activity } = applyHeartbeat(body, previous, now, (loopId) =>
      loopId === reportedLoopId ? reportedLoopName : null,
    );

    const device = await prisma.device.upsert({
      where: { serialNumber: body.serialNumber },
      update: { ...fields, ...locationFields },
      create: { serialNumber: body.serialNumber, ...fields, ...locationFields },
    });

    // Keep the device's raw payload, plus what the server made of it, for trails and debugging.
    const locationData: Prisma.InputJsonValue | undefined = body.location
      ? {
          ...body.location,
          resolved: position
            ? {
                lat: position.lat,
                lng: position.lng,
                accuracyM: position.accuracyM,
                source: position.source,
                at: position.at.toISOString(),
                provider: position.provider ?? null,
              }
            : null,
          servingCell: cell
            ? { radio: cell.radio, mcc: cell.mcc, mnc: cell.mnc, lac: cell.lac, cellId: cell.cellId }
            : null,
        }
      : undefined;

    await prisma.deviceHeartbeat.create({
      data: {
        deviceId: device.id,
        ipAddress: body.ipAddress,
        firmwareVersion: body.firmwareVersion,
        storageFreeMb: body.storageFreeMb,
        currentLoopId: body.currentLoopId,
        cpuTemp: body.cpuTemp,
        uptimeSeconds: body.uptimeSeconds,
        memoryUsedPercent: body.memoryUsedPercent,
        playerStatus: body.playerStatus,
        networkType: body.networkType,
        // Stored as sent (old firmware: a percentage); the normalised figures are on the Device.
        signalStrength: body.signalStrength,
        signalPercent: fields.signalPercent,
        playbackTrigger: body.playbackTrigger,
        safetyChecksum: body.safetyChecksum,
        syncState: body.sync?.state,
        syncError: body.sync ? fields.syncError : undefined,
        locationData,
        receivedAt: now,
      },
    });

    for (const event of activity) {
      await logActivity(event.type, event.message, { ...event.metadata, deviceId: device.id });
    }

    const expected = resolveDeviceLoop(device, snapshot);
    const safety = await getConfiguredSafetyMessage(settings);

    return apiResponse({
      ok: true,
      deviceId: device.id,
      expectedLoopId: expected.loop?.id ?? null,
      expectedChecksum: expected.loop?.checksum ?? null,
      disabled: device.isDisabled || fleetControl.disabled,
      // DEVICE_CONTRACT_V2 (firmware 1.2.0+; older firmware ignores both). The key is left out
      // when a configured safety message has no checksum to compare with ("no opinion").
      ...(safety && !safety.checksum ? {} : { expectedSafetyChecksum: safety?.checksum ?? null }),
      config: {
        heartbeatIntervalSeconds: clamp(settings.heartbeatIntervalSeconds, 60, 3600),
        syncIntervalSeconds: clamp(settings.syncIntervalSeconds, 300, 86400),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
