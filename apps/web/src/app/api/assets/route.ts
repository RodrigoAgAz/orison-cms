import { prisma } from "@orison/db";
import { assetListQuerySchema } from "@orison/shared";

import { apiError, apiResponse } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = assetListQuerySchema.parse({
      category: url.searchParams.get("category") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });

    const where = {
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            filename: {
              contains: query.search,
              mode: "insensitive" as const,
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.asset.count({ where }),
    ]);

    return apiResponse({
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
    });
  } catch (error) {
    return apiError(error);
  }
}

