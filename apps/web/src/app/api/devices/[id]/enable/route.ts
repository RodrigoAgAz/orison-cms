import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";

import { requireApiUser } from "@/lib/auth";
import { publicDevice } from "@/lib/device-public";
import { logActivity } from "@/lib/activity";
import { apiError, apiResponse } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function PUT(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const device = await prisma.device.update({
      where: { id: params.id },
      data: {
        isDisabled: false,
        disabledReason: null,
      },
    });

    await logActivity("DEVICE_ENABLED", `Device ${device.serialNumber} enabled`, {
      deviceId: device.id,
      serialNumber: device.serialNumber,
    });

    revalidatePath("/");
    revalidatePath("/devices");

    return apiResponse(publicDevice(device));
  } catch (error) {
    return apiError(error);
  }
}

/** Mobile app (CONTRACT.md) uses POST; same behaviour as PUT. */
export const POST = PUT;
