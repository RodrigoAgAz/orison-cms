import { rm } from "node:fs/promises";
import path from "node:path";

import { createLoopSchema, directLoopUploadMaxBytes, directLoopUploadMaxDurationMs } from "@orison/shared";

import { assignTargetSchema, describeTarget, type AssignTarget } from "@/lib/assignment";
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

type UploadParams = { name: string; filename: string; target: AssignTarget | null };

/** Validate the query string (name, filename, target); throws ApiError with a user-facing message. */
async function parseUploadParams(url: URL): Promise<UploadParams> {
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
  return { name: nameResult.data.name, filename, target };
}

/**
 * Check an upload before (or after a failed) send: same checks as POST up to receiving the body
 * (signed in, name, file type, target exists), without a body. `{ ok: true }` or the error POST
 * would give. The phone uses it to tell "the server refused this upload" from a dropped connection.
 */
export async function GET(request: Request) {
  try {
    await requireApiUser();
    await parseUploadParams(new URL(request.url));
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Raw-body video upload from the phone. Streams to a temp file, creates the Loop row
 * (PUBLISHING, autoLive false) and returns 202 { loopId } while transcoding runs in the background.
 */
export async function POST(request: Request) {
  // A change to the same target after this moment wins over the upload's target.
  const requestedAt = new Date();
  let tempDir: string | null = null;
  try {
    const user = await requireApiUser();
    const { name, filename, target } = await parseUploadParams(new URL(request.url));

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

    const loop = await createPendingUploadLoop({ name, pendingTarget: target, requestedAt });
    const ownedTempDir = tempDir;
    tempDir = null; // the background job owns it now

    startUploadedLoopProcessing({
      loopId: loop.id,
      originalFilename: filename,
      tempFilePath: upload.tempFilePath,
      tempDir: ownedTempDir,
      publishedBy: { id: user.id, name: user.name },
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
