import { revalidatePath } from "next/cache";
import { prisma } from "@orison/db";
import { createLoopSchema } from "@orison/shared";

import { createLoopDraft } from "@/lib/loops";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

export async function GET() {
  try {
    const loops = await prisma.loop.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        slots: {
          include: {
            contents: true,
          },
        },
      },
    });

    return apiResponse(loops);
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createLoopSchema);
    const loop = await createLoopDraft(body.name);
    revalidatePath("/");
    revalidatePath("/loops");
    return apiResponse(loop, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
