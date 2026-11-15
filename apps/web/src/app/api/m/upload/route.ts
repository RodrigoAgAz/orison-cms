import { rm } from "node:fs/promises";
import path from "node:path";

import { createLoopSchema, directLoopUploadMaxBytes, directLoopUploadMaxDurationMs } from "@orison/shared";

import { assignLoop, assignTargetSchema, describeTarget, type AssignTarget } from "@/lib/assignment";
import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { createPendingUploadLoop, directLoopUploadExtensions, startUploadedLoopProcessing } from "@/lib/loops";
import { looksLikeIsoMediaFile, streamRequestBodyToTempFile } from "@/lib/upload-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limitsMessage = `Videos must be MP4, MOV or M4V, up to ${Math.round(
  directLoopUploadMaxBytes / (1024 * 1024),
)}MB and ${Math.round(directLoopUploadMaxDurationMs / 60000)} minutes long.`;

function parseTarget(raw: string | null): AssignTarget | null {
  if (!raw) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiError("target must be URL-encoded JSON", 400);
  }
  const result = assignTargetSchema.safeParse(json);
  if (!result.success) {
    throw new ApiError("Invalid target", 400, result.error.flatten());
  }
  return result.data;
}

/**
 * Raw-body video upload from the phone. Streams to a temp file, creates the Loop row
 * (PUBLISHING, autoLive false) and returns 202 { loopId } while transcoding runs in the background.
 */
export async function POST(request: Request) {
  let tempDir: string | null = null;
  try {
    const user = await requireApiUser();
    const url = new URL(request.url);

    const nameResult = createLoopSchema.safeParse({ name: url.searchParams.get("name")?.trim() ?? "" });
    if (!nameResult.success) {
      throw new ApiError("Give the video a name (2-120 characters)", 400, nameResult.error.flatten());
    }
    const filename = url.searchParams.get("filename")?.trim() || "upload.mov";
    const extension = path.extname(filename).toLowerCase();
    if (!(directLoopUploadExtensions as readonly string[]).includes(extension)) {
      throw new ApiError(limitsMessage, 400);
    }
    const target = parseTarget(url.searchParams.get("target"));
    if (target) {
      await describeTarget(target); // 404 early for an unknown group/cab
    }

    const upload = await streamRequestBodyToTempFile(request, {
      filename,
      maxBytes: directLoopUploadMaxBytes,
      tooLargeMessage: limitsMessage,
      missingMessage: "The request body must be the video file",
      prefix: "orison-mobile-upload-",
    });
    tempDir = upload.tempDir;
    if (upload.sizeBytes === 0) {
      throw new ApiError("The uploaded file is empty", 400);
    }
    if (!(await looksLikeIsoMediaFile(upload.tempFilePath))) {
      throw new ApiError(`This file is not a supported video. ${limitsMessage}`, 415);
    }

    const loop = await createPendingUploadLoop({ name: nameResult.data.name, pendingTarget: target });
    const ownedTempDir = tempDir;
    tempDir = null; // the background job owns it now

    startUploadedLoopProcessing({
      loopId: loop.id,
      originalFilename: filename,
      tempFilePath: upload.tempFilePath,
      tempDir: ownedTempDir,
      publishedByUserId: user.id,
      onPublished: target
        ? async (published) => {
            await assignLoop({ loopId: published.id, target }, user);
          }
        : undefined,
    });

    return apiResponse({ loopId: loop.id }, { status: 202 });
  } catch (error) {
    return apiError(error);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
