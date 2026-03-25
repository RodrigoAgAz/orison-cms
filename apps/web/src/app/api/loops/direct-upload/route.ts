import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { revalidatePath } from "next/cache";

import {
  createLoopSchema,
  directLoopUploadMaxBytes,
  directLoopUploadMaxDurationMs,
} from "@orison/shared";

import { getSessionUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { publishDirectLoopUpload } from "@/lib/loops";

export const runtime = "nodejs";

function sanitizeFilename(filename: string) {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.length > 0 ? base : "loop.mp4";
}

function directUploadErrorMessage() {
  return `Direct loop uploads must be an MP4 up to ${Math.round(
    directLoopUploadMaxBytes / (1024 * 1024),
  )}MB and ${Math.round(directLoopUploadMaxDurationMs / 60000)} minutes long.`;
}

async function streamRequestBodyToTempFile(request: Request, filename: string) {
  if (!request.body) {
    throw new ApiError("A direct loop MP4 upload is required");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > directLoopUploadMaxBytes) {
      throw new ApiError(directUploadErrorMessage(), 413);
    }
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orison-direct-upload-"));
  const tempFilePath = path.join(tempDir, sanitizeFilename(filename));
  let uploadedBytes = 0;

  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      uploadedBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);

      if (uploadedBytes > directLoopUploadMaxBytes) {
        callback(new ApiError(directUploadErrorMessage(), 413));
        return;
      }

      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(request.body as any),
    limiter,
    createWriteStream(tempFilePath),
  );

  return {
    tempDir,
    tempFilePath,
  };
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

    const upload = await streamRequestBodyToTempFile(request, filename);
    tempDir = upload.tempDir;

    const result = await publishDirectLoopUpload({
      name: nameResult.data.name,
      originalFilename: filename,
      tempFilePath: upload.tempFilePath,
      publishedByUserId: user.id,
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
