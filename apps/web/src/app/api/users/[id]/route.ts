import { z } from "zod";

import { prisma } from "@orison/db";
import { userRoleSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { hashPassword, requireApiAdmin } from "@/lib/auth";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const publicUserSelect = { id: true, name: true, email: true, role: true, createdAt: true } as const;

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: userRoleSchema.optional(),
    password: z.string().min(8).max(200).optional(),
  })
  .strict();

type Props = { params: { id: string } };

async function adminCount() {
  return prisma.user.count({ where: { role: "ADMIN" } });
}

export async function PATCH(request: Request, { params }: Props) {
  try {
    const admin = await requireApiAdmin();
    const body = await parseJsonBody(request, updateUserSchema);
    const existing = await prisma.user.findUnique({ where: { id: params.id } });
    if (!existing) {
      throw new ApiError("User not found", 404);
    }
    if (body.role && body.role !== "ADMIN" && existing.role === "ADMIN" && (await adminCount()) <= 1) {
      throw new ApiError("You cannot remove the last admin", 409);
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        role: body.role,
        passwordHash: body.password ? await hashPassword(body.password) : undefined,
      },
      select: publicUserSelect,
    });
    const changed = Object.keys(body).filter((key) => key !== "password");
    await logActivity(
      "USER_UPDATED",
      `${admin.name} updated ${user.name}${body.password ? " (password reset)" : ""}`,
      { userId: user.id, byUserId: admin.id, fields: changed, passwordReset: Boolean(body.password) },
    );
    return apiResponse(user);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    const admin = await requireApiAdmin();
    if (params.id === admin.id) {
      throw new ApiError("You cannot delete your own account", 409);
    }
    const existing = await prisma.user.findUnique({ where: { id: params.id } });
    if (!existing) {
      throw new ApiError("User not found", 404);
    }
    if (existing.role === "ADMIN" && (await adminCount()) <= 1) {
      throw new ApiError("You cannot delete the last admin", 409);
    }
    await prisma.user.delete({ where: { id: existing.id } });
    await logActivity("USER_DELETED", `${admin.name} removed ${existing.name}`, {
      userId: existing.id,
      email: existing.email,
      byUserId: admin.id,
    });
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
