import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";
import { deviceGroupInputSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { apiError, apiResponse } from "@/lib/http";
import { parseBody, toApiError } from "@/lib/loop-api";

export async function GET() {
  try {
    await requireApiUser();
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
    return apiError(toApiError(error));
  }
}

export async function POST(request: Request) {
  try {
    await requireApiUser();
    const body = await parseBody(request, deviceGroupInputSchema);
    const group = await prisma.deviceGroup.create({
      data: {
        name: body.name,
        description: body.description ?? null,
      },
    });

    await logActivity("DEVICE_GROUP_CREATED", `Group ${group.name} created`, {
      groupId: group.id,
      name: group.name,
    });

    revalidatePath("/devices");
    revalidatePath("/loops");

    return apiResponse(group, { status: 201 });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
