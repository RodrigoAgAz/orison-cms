import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { prisma, type Prisma } from "@orison/db";
import { assetCategorySchema, directLoopUploadMaxBytes } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { mediaJobLimiter } from "@/lib/job-limits";
import { toApiError } from "@/lib/loop-api";
import { assetKeysFor, processAssetUpload } from "@/lib/media";
import { sanitizeUploadFilename, streamRequestBodyToTempFile } from "@/lib/upload-stream";

export const runtime = "nodejs";

const videoExtensions = [".mp4", ".mov", ".m4v", ".webm"];
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
const maxBytes = directLoopUploadMaxBytes;

function kindOf(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (videoExtensions.includes(extension)) return "video" as const;
  if (imageExtensions.includes(extension)) return "image" as const;
  return null;
}

/**
 * Upload an asset. The body is the file itself, streamed to disk (never held in memory):
 *   POST /api/assets/upload?filename=ad.mov&category=ADVERTISEMENT&metadata={json}
 * (multipart/form-data with fields file, category, metadata is still accepted for older clients).
 * Answers 201 at once with the asset in PROCESSING; it is normalised in the background (one media
 * job at a time) and becomes READY, or FAILED with a short reason the library shows.
 */
export async function POST(request: Request) {
  let tempDir: string | null = null;
  try {
    await requireApiUser();
    const url = new URL(request.url);
    let filename: string;
    let categoryValue: string | null;
    let metadataValue: string | null;
    let tempFilePath: string;

    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) throw new ApiError("Choose a file to upload.");
      if (file.size > maxBytes) throw new ApiError(`Files are limited to ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413);
      filename = file.name;
      categoryValue = formData.get("category") as string | null;
      metadataValue = (formData.get("metadata") as string | null) || null;
      tempDir = await mkdtemp(path.join(os.tmpdir(), "orison-asset-upload-"));
      tempFilePath = path.join(tempDir, sanitizeUploadFilename(filename, "upload.bin"));
      await writeFile(tempFilePath, Buffer.from(await file.arrayBuffer()));
    } else {
      filename = url.searchParams.get("filename")?.trim() || "";
      categoryValue = url.searchParams.get("category");
      metadataValue = url.searchParams.get("metadata");
      if (!filename) throw new ApiError("The file name is missing.");
      if (!kindOf(filename)) throw new ApiError("Upload an MP4, MOV, M4V or WebM video, or a JPG, PNG or WebP image.");
      const upload = await streamRequestBodyToTempFile(request, {
        filename,
        maxBytes,
        tooLargeMessage: `Files are limited to ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        missingMessage: "Choose a file to upload.",
        prefix: "orison-asset-upload-",
      });
      tempDir = upload.tempDir;
      tempFilePath = upload.tempFilePath;
    }

    const kind = kindOf(filename);
    if (!kind) throw new ApiError("Upload an MP4, MOV, M4V or WebM video, or a JPG, PNG or WebP image.");
    const category = assetCategorySchema.safeParse(categoryValue);
    if (!category.success) throw new ApiError("Choose a category for the file.");
    let metadata: Prisma.InputJsonValue | undefined;
    if (metadataValue) {
      try {
        metadata = JSON.parse(metadataValue) as Prisma.InputJsonValue;
      } catch {
        throw new ApiError("The advertiser / campaign details could not be read.");
      }
    }

    const assetId = randomUUID().replace(/-/g, "");
    const keys = assetKeysFor(assetId, kind);
    const asset = await prisma.asset.create({
      data: {
        id: assetId,
        filename,
        s3Key: keys.s3Key,
        thumbnailKey: keys.thumbnailKey,
        mimeType: kind === "video" ? "video/mp4" : "image/jpeg",
        fileSize: 0,
        category: category.data,
        metadata,
        status: "PROCESSING",
      },
    });
    await logActivity("ASSET_UPLOADED", `Asset ${filename} uploaded`, { assetId: asset.id, category: asset.category });

    // Media jobs run in this process (one at a time); the temp folder is removed afterwards.
    const ownedDir = tempDir;
    tempDir = null;
    void mediaJobLimiter()
      .run(() => processAssetUpload(asset.id, tempFilePath))
      .catch((error) => console.error(`asset ${asset.id} processing crashed`, error))
      .finally(() => rm(ownedDir, { recursive: true, force: true }).catch(() => undefined));

    return apiResponse(asset, { status: 201 });
  } catch (error) {
    return apiError(toApiError(error));
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
