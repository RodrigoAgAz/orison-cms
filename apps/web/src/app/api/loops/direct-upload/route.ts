import { rm } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";

import {
  createLoopSchema,
  directLoopUploadMaxBytes,
  directLoopUploadMaxDurationMs,
} from "@orison/shared";

import { getSessionUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { prisma } from "@orison/db";

import { directLoopUploadExtensions, LoopUploadError, publishDirectLoopUpload } from "@/lib/loops";
import { streamRequestBodyToTempFile } from "@/lib/upload-stream";

export const runtime = "nodejs";

function directUploadErrorMessage() {
  return `Pre-built loops must be an MP4 or MOV file up to ${Math.round(
    directLoopUploadMaxBytes / (1024 * 1024),
  )}MB and ${Math.round(directLoopUploadMaxDurationMs / 60000)} minutes long.`;
}

export async function POST(request: Request) {
  let tempDir: string | null = null;

  try {
    const user = await getSessionUser();
    if (!user) {
      throw new ApiError("Unauthenticated", 401);
    }

    const url = new URL(request.url);
    const nameResult = createLoopSchema.safeParse({
      name: url.searchParams.get("name")?.trim() ?? "",
    });

    if (!nameResult.success) {
      throw new ApiError("Name must be between 2 and 120 characters.", 400, nameResult.error.flatten());
    }

    const filename = url.searchParams.get("filename")?.trim() ?? "loop.mp4";
    if (!(directLoopUploadExtensions as readonly string[]).includes(path.extname(filename).toLowerCase())) {
      throw new ApiError("Pre-built loops must be an .mp4, .mov or .m4v file.", 400);
    }

    // Where it plays once ready: "all" (all cabs), a group id, or "library" (kept off air).
    // Missing (older clients): all cabs, as before.
    const targetParam = url.searchParams.get("target")?.trim() || "all";
    let target: { groupId: string | null } | "library" = { groupId: null };
    if (targetParam === "library") {
      target = "library";
    } else if (targetParam !== "all") {
      const group = await prisma.deviceGroup.findUnique({ where: { id: targetParam }, select: { id: true } });
      if (!group) {
        throw new ApiError("That group no longer exists.", 400);
      }
      target = { groupId: group.id };
    }

    const upload = await streamRequestBodyToTempFile(request, {
      filename,
      maxBytes: directLoopUploadMaxBytes,
      tooLargeMessage: directUploadErrorMessage(),
      missingMessage: "A direct loop MP4 upload is required",
    });
    tempDir = upload.tempDir;

    const result = await publishDirectLoopUpload({
      name: nameResult.data.name,
      originalFilename: filename,
      tempFilePath: upload.tempFilePath,
      publishedByUserId: user.id,
      target,
    }).catch((error) => {
      // Bad input: a 400 with the reason (it was a 500 before).
      if (error instanceof LoopUploadError) {
        throw new ApiError(error.message, 400);
      }
      throw error;
    });

    revalidatePath("/");
    revalidatePath("/loops");
    revalidatePath(`/loops/${result.loopId}`);
    revalidatePath("/devices");

    return apiResponse(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
