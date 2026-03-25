import { revalidatePath } from "next/cache";
import { prisma } from "@orison/db";
import { updateLoopSchema } from "@orison/shared";

import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function GET(_: Request, { params }: Props) {
  try {
    const loop = await prisma.loop.findUnique({
      where: { id: params.id },
      include: {
        slots: {
          orderBy: { position: "asc" },
          include: {
            contents: {
              orderBy: { orderInSlot: "asc" },
              include: {
                asset: true,
              },
            },
          },
        },
      },
    });

    if (!loop) {
      throw new ApiError("Loop not found", 404);
    }

    return apiResponse(loop);
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request, { params }: Props) {
  try {
    const body = await parseJsonBody(request, updateLoopSchema);
    const loop = await prisma.loop.update({
      where: { id: params.id },
      data: body,
    });
    revalidatePath("/");
    revalidatePath("/loops");
    revalidatePath(`/loops/${params.id}`);
    revalidatePath("/devices");
    return apiResponse(loop);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    const loop = await prisma.loop.findUnique({
      where: { id: params.id },
    });

    if (!loop) {
      throw new ApiError("Loop not found", 404);
    }

    if (loop.status === "PUBLISHED") {
      throw new ApiError("Pause this loop before deleting it", 409);
    }

    await prisma.loop.delete({
      where: { id: loop.id },
    });

    revalidatePath("/");
    revalidatePath("/loops");
    revalidatePath(`/loops/${params.id}`);
    revalidatePath("/devices");

    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
