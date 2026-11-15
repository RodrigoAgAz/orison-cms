import { type NextRequest } from "next/server";

import { prisma, type Prisma } from "@orison/db";
import { heartbeatSchema } from "@orison/shared";

import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import { authenticateDeviceRequest } from "@/lib/device-auth";
import { resolveHeartbeatLocation } from "@/lib/device-location";
import { getFleetControlState } from "@/lib/fleet-control";
import { getLoopRoutingSnapshot, resolveDeviceLoop } from "@/lib/loop-routing";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request, heartbeatSchema);
    enforceDeviceRateLimit(request, "device-heartbeat", body.serialNumber, {
      limit: 120,
      windowMs: 5 * 60 * 1000,
    });
    await authenticateDeviceRequest(request, body.serialNumber, {
      allowUnregisteredSharedToken: true,
    });

    const now = new Date();
    // Never fails: GPS wins, otherwise the serving cell via cache/providers (short timeout).
    const { position, cell } = await resolveHeartbeatLocation(body.location, now);
    const locationFields = position
      ? {
          locationLat: position.lat,
          locationLng: position.lng,
          locationAccuracyM: position.accuracyM,
          locationSource: position.source,
          locationAt: position.at,
        }
      : {};

    const device = await prisma.device.upsert({
      where: { serialNumber: body.serialNumber },
      update: {
        ipAddress: body.ipAddress,
        firmwareVersion: body.firmwareVersion,
        storageFreeMb: body.storageFreeMb,
        currentLoopId: body.currentLoopId,
        lastHeartbeatAt: now,
        ...locationFields,
      },
      create: {
        serialNumber: body.serialNumber,
        ipAddress: body.ipAddress,
        firmwareVersion: body.firmwareVersion,
        storageFreeMb: body.storageFreeMb,
        currentLoopId: body.currentLoopId,
        lastHeartbeatAt: now,
        ...locationFields,
      },
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
        signalStrength: body.signalStrength,
        locationData,
        receivedAt: now,
      },
    });

    const [snapshot, fleetControl] = await Promise.all([getLoopRoutingSnapshot(), getFleetControlState()]);
    const expected = resolveDeviceLoop(device, snapshot);

    return apiResponse({
      ok: true,
      deviceId: device.id,
      expectedLoopId: expected.loop?.id ?? null,
      expectedChecksum: expected.loop?.checksum ?? null,
      disabled: device.isDisabled || fleetControl.disabled,
    });
  } catch (error) {
    return apiError(error);
  }
}
