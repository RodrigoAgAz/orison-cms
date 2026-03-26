import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";

import { logActivity } from "@/lib/activity";
import { apiError, apiResponse } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function PUT(_: Request, { params }: Props) {
  try {
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

    return apiResponse(device);
  } catch (error) {
    return apiError(error);
  }
}
