import { randomUUID } from "node:crypto";

import { prisma, type Prisma } from "@orison/db";
import { uploadAssetFormSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { env } from "@/lib/env";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { processAssetUpload } from "@/lib/media";
import { enqueueAssetProcessingJob } from "@/lib/queues";
import { writeUploadedFileToTemp } from "@/lib/upload";

function assetKeys(assetId: string, filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase();
  const isVideo = ["mp4", "mov", "webm"].includes(extension ?? "");
  return {
    s3Key: isVideo ? `assets/${assetId}/content.mp4` : `assets/${assetId}/original.${extension ?? "bin"}`,
    thumbnailKey: isVideo ? `assets/${assetId}/thumbnail.jpg` : null,
  };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      throw new ApiError("A file upload is required");
    }

    const form = uploadAssetFormSchema.safeParse({
      category: formData.get("category"),
      metadata: formData.get("metadata") || undefined,
    });

    if (!form.success) {
      throw new ApiError("Invalid upload payload", 400, form.error.flatten());
    }

    const metadata = form.data.metadata
      ? (JSON.parse(form.data.metadata) as Prisma.InputJsonValue)
      : undefined;

    const upload = await writeUploadedFileToTemp(file);
    const assetId = randomUUID().replace(/-/g, "");
    const keys = assetKeys(assetId, file.name);

    const asset = await prisma.asset.create({
      data: {
        id: assetId,
        filename: file.name,
        s3Key: keys.s3Key,
        thumbnailKey: keys.thumbnailKey,
        mimeType: file.type || "application/octet-stream",
        fileSize: upload.buffer.byteLength,
        category: form.data.category,
        metadata,
        status: "PROCESSING",
      },
    });

    await logActivity("ASSET_UPLOADED", `Asset ${file.name} uploaded`, {
      assetId: asset.id,
      category: asset.category,
    });

    if (env.inlineMediaJobs || !(await enqueueAssetProcessingJob({ assetId: asset.id, tempFilePath: upload.tempFilePath }))) {
      await processAssetUpload(asset.id, upload.tempFilePath);
    }

    const latest = await prisma.asset.findUniqueOrThrow({
      where: { id: asset.id },
    });

    return apiResponse(latest, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

