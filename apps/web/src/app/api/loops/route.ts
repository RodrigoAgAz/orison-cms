import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { createLoopDraft } from "@/lib/loops";
import { apiError, apiResponse } from "@/lib/http";
import { parseBody, toApiError } from "@/lib/loop-api";
import { getLoopListData } from "@/lib/loop-queries";

function parsePageParam(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    await requireApiUser();
    const url = new URL(request.url);
    const data = await getLoopListData({
      page: parsePageParam(url.searchParams.get("page"), 1),
      pageSize: Math.min(parsePageParam(url.searchParams.get("pageSize"), 25), 100),
    });
    return apiResponse({ items: data.items, page: data.page, pageSize: data.pageSize, total: data.total });
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function POST(request: Request) {
  try {
    await requireApiUser();
    const body = await parseBody(request, z.object({ name: z.string().trim().min(2).max(120) }));
    const loop = await createLoopDraft(body.name);
    return apiResponse(loop, { status: 201 });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
