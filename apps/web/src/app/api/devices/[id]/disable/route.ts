import { revalidatePath } from "next/cache";

import { z } from "zod";

import { prisma } from "@orison/db";

import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

const disableSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
});

type Props = {
  params: {
    id: string;
  };
};

export async function PUT(request: Request, { params }: Props) {
  try {
    const body = await parseJsonBody(request, disableSchema);
    const device = await prisma.device.update({
      where: { id: params.id },
      data: {
        isDisabled: true,
        disabledReason: body.reason ?? null,
      },
    });

    await logActivity("DEVICE_DISABLED", `Device ${device.serialNumber} disabled`, {
      deviceId: device.id,
      serialNumber: device.serialNumber,
      reason: body.reason ?? null,
    });

    revalidatePath("/");
    revalidatePath("/devices");

    return apiResponse(device);
  } catch (error) {
    return apiError(error);
  }
}
