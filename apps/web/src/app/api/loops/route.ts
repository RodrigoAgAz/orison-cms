import { revalidatePath } from "next/cache";
import { prisma } from "@orison/db";
import { createLoopSchema } from "@orison/shared";

import { createLoopDraft } from "@/lib/loops";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

function parsePageParam(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const page = parsePageParam(url.searchParams.get("page"), 1);
    const pageSize = parsePageParam(url.searchParams.get("pageSize"), 25);
    const [loops, total] = await Promise.all([
      prisma.loop.findMany({
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          slots: {
            include: {
              contents: true,
            },
          },
        },
      }),
      prisma.loop.count(),
    ]);

    return apiResponse({ items: loops, page, pageSize, total });
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
