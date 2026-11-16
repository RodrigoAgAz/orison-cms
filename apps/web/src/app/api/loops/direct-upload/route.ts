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
import { LoopUploadError, publishDirectLoopUpload } from "@/lib/loops";
import { streamRequestBodyToTempFile } from "@/lib/upload-stream";

export const runtime = "nodejs";

function directUploadErrorMessage() {
  return `Direct loop uploads must be an MP4 up to ${Math.round(
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
      throw new ApiError("Invalid loop name", 400, nameResult.error.flatten());
    }

    const filename = url.searchParams.get("filename")?.trim() ?? "loop.mp4";
    if (path.extname(filename).toLowerCase() !== ".mp4") {
      throw new ApiError("Direct loop uploads must be provided as an .mp4 file", 400);
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
    }).catch((error) => {
      // Same messages as before the refactor; they were surfaced as 500s then too.
      if (error instanceof LoopUploadError) {
        throw new ApiError(error.message, 500);
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
