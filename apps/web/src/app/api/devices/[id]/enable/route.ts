import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";

import { actorMetadata, requireApiUser, requirePhoneAppActor, type PhoneActor } from "@/lib/auth";
import { publicDevice } from "@/lib/device-public";
import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, ApiError } from "@/lib/http";

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

async function enableDevice(params: Props["params"], actor: PhoneActor) {
  await requireDeviceExists(params.id);
  const device = await prisma.device.update({
    where: { id: params.id },
    data: {
      isDisabled: false,
      disabledReason: null,
    },
  });

  await logActivity("DEVICE_ENABLED", `Device ${device.serialNumber} enabled by ${actor.name}`, {
    deviceId: device.id,
    serialNumber: device.serialNumber,
    ...actorMetadata(actor),
  });

  revalidatePath("/");
  revalidatePath("/devices");

  // Callers who are not signed in only learn the new state, not the device record.
  return actor.anonymous
    ? { id: device.id, isDisabled: device.isDisabled, disabledReason: device.disabledReason }
    : publicDevice(device);
}

/** Desktop site: signed-in users only. */
export async function PUT(_: Request, { params }: Props) {
  try {
    const user = await requireApiUser();
    return apiResponse(await enableDevice(params, { ...user, anonymous: false, ip: null, forwardedFor: null }));
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Phone app (CONTRACT.md) uses POST; same behaviour as PUT. Open to callers who are not signed in
 * unless PHONE_APP_REQUIRE_SIGN_IN is set (see lib/phone-access.ts).
 */
export async function POST(_: Request, { params }: Props) {
  try {
    const actor = await requirePhoneAppActor();
    return apiResponse(await enableDevice(params, actor));
  } catch (error) {
    return apiError(error);
  }
}
