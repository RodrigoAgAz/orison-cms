import { z } from "zod";

import { prisma, Prisma } from "@orison/db";
import { userRoleSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { hashPassword, requireApiAdmin } from "@/lib/auth";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const publicUserSelect = { id: true, name: true, email: true, role: true, createdAt: true } as const;

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: userRoleSchema,
});

export async function GET() {
  try {
    await requireApiAdmin();
    const items = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: publicUserSelect });
    return apiResponse({ items });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireApiAdmin();
    const body = await parseJsonBody(request, createUserSchema);
    try {
      const user = await prisma.user.create({
        data: {
          name: body.name,
          email: body.email,
          role: body.role,
          passwordHash: await hashPassword(body.password),
        },
        select: publicUserSelect,
      });
      await logActivity("USER_CREATED", `${admin.name} added ${user.name} (${user.role.toLowerCase()})`, {
        userId: user.id,
        byUserId: admin.id,
      });
      return apiResponse(user, { status: 201 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError("A user with this email already exists", 409);
      }
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}
