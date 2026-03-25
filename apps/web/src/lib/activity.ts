import { prisma, type Prisma } from "@orison/db";
import type { ActivityEventType } from "@orison/shared";

export async function logActivity(
  type: ActivityEventType,
  message: string,
  metadata?: Prisma.InputJsonValue,
) {
  return prisma.activityEvent.create({
    data: {
      type,
      message,
      metadata,
    },
  });
}

