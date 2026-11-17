import { revalidatePath } from "next/cache";

import { z } from "zod";

import { prisma } from "@orison/db";

import { actorMetadata, requireApiUser, requirePhoneAppActor, type PhoneActor } from "@/lib/auth";
import { publicDevice } from "@/lib/device-public";
import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

const disableSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
});

async function requireDeviceExists(id: string) {
  if (!(await prisma.device.findUnique({ where: { id }, select: { id: true } }))) {
    throw new ApiError("Cab not found", 404);
  }
}

type Props = {
  params: {
    id: string;
  };
};

async function disableDevice(request: Request, params: Props["params"], actor: PhoneActor) {
  const body = await parseJsonBody(request, disableSchema);
  await requireDeviceExists(params.id);
  const device = await prisma.device.update({
    where: { id: params.id },
    data: {
      isDisabled: true,
      disabledReason: body.reason ?? null,
    },
  });

  await logActivity("DEVICE_DISABLED", `Cab ${device.serialNumber} paused by ${actor.name}`, {
    deviceId: device.id,
    serialNumber: device.serialNumber,
    reason: body.reason ?? null,
    ...actorMetadata(actor),
  });

  revalidatePath("/");
  revalidatePath("/devices");

  // Callers who are not signed in only learn the new state, not the device record (IP address,
  // notes, cab ids).
  return actor.anonymous
    ? { id: device.id, isDisabled: device.isDisabled, disabledReason: device.disabledReason }
    : publicDevice(device);
}

/** Desktop site: signed-in users only. */
export async function PUT(request: Request, { params }: Props) {
  try {
    const user = await requireApiUser();
    return apiResponse(
      await disableDevice(request, params, { ...user, anonymous: false, ip: null, forwardedFor: null }),
    );
  } catch (error) {
    return apiError(error);
  }
}

/**
 * The phone app uses POST; same behaviour as PUT. Open to callers who are not signed in
 * unless PHONE_APP_REQUIRE_SIGN_IN is set (see lib/phone-access.ts).
 */
export async function POST(request: Request, { params }: Props) {
  try {
    const actor = await requirePhoneAppActor();
    return apiResponse(await disableDevice(request, params, actor));
  } catch (error) {
    return apiError(error);
  }
}
