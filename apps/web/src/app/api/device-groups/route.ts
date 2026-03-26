import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";
import { deviceGroupInputSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

export async function GET() {
  try {
    const groups = await prisma.deviceGroup.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: {
            devices: true,
            loops: true,
          },
        },
      },
    });

    return apiResponse(groups);
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, deviceGroupInputSchema);
    const group = await prisma.deviceGroup.create({
      data: {
        name: body.name,
        description: body.description ?? null,
      },
    });

    await logActivity("DEVICE_GROUP_CREATED", `Device group ${group.name} created`, {
      groupId: group.id,
      name: group.name,
    });

    revalidatePath("/devices");
    revalidatePath("/loops");

    return apiResponse(group, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
