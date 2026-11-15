import { z } from "zod";

import { prisma } from "@orison/db";

import { logActivity } from "@/lib/activity";
import { hashPassword, requireApiUser, revokeUserSessions, verifyPassword } from "@/lib/auth";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  try {
    const sessionUser = await requireApiUser();
    const body = await parseJsonBody(request, changePasswordSchema);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sessionUser.id } });
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw new ApiError("Current password is incorrect", 400);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword) },
    });
    // Sign out every other device; this one gets a fresh cookie and stays signed in.
    await revokeUserSessions(user.id, { keepCurrentSession: true });
    await logActivity("USER_PASSWORD_CHANGED", `${user.name} changed their password`, { userId: user.id });
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
