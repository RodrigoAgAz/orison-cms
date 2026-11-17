// The desktop's rules for uploads in pieces (lib/chunked-upload.ts does the piece handling; the
// browser side is lib/piece-sender.ts). Two kinds of upload go through here:
//
// - "asset": a file for the library (video or still image). Once joined it becomes an Asset in
//   PROCESSING and is normalised in the background, exactly as the single-request upload did.
// - "loop": a pre-built loop (one finished video). Once joined it becomes a Loop in PUBLISHING and
//   is converted in the background; then it is kept off air or put on air for all cabs or a group,
//   as chosen (and confirmed) in the form before the upload started.
//
// Everything that can be checked before a byte is sent is checked when the upload is opened
// (signed in, file type, size, name, category, group exists). Every route is signed-in only
// (requireApiUser), whatever the middleware does.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma, type Prisma } from "@orison/db";
import { assetCategorySchema, createLoopSchema, directLoopUploadMaxBytes, directLoopUploadMaxDurationMs } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { ApiError } from "@/lib/http";
import { mediaJobLimiter } from "@/lib/job-limits";
import { createPendingDesktopLoop, directLoopUploadExtensions, startUploadedLoopProcessing, type DesktopUploadTarget } from "@/lib/loops";
import { assetKeysFor, processAssetUpload } from "@/lib/media";
import { looksLikeIsoMediaFile } from "@/lib/upload-stream";

/** Sessions opened here are only seen by these routes (not by the phone app's). */
export const DESKTOP_UPLOAD_SCOPE = "desktop";

/** Folder prefixes of the joined file; the server's start-up cleanup (lib/upload-temp.ts) knows them. */
export const JOINED_TEMP_PREFIX = { asset: "orison-asset-upload-", loop: "orison-direct-upload-" } as const;

const megabytes = Math.round(directLoopUploadMaxBytes / (1024 * 1024));

export const assetLimitsMessage = `Upload an MP4, MOV, M4V or WebM video, or a JPG, PNG or WebP image, up to ${megabytes} MB.`;
export const loopLimitsMessage = `Pre-built loops must be an MP4, MOV or M4V file up to ${megabytes} MB and ${Math.round(
  directLoopUploadMaxDurationMs / 60000,
)} minutes long.`;

const videoExtensions = [".mp4", ".mov", ".m4v", ".webm"];
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];

export function assetKindOf(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  if (videoExtensions.includes(extension)) return "video" as const;
  if (imageExtensions.includes(extension)) return "image" as const;
  return null;
}

const common = {
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().min(0),
  // The client's fingerprint; the kind is added in front of it (one file can be both an asset and a loop).
  fingerprint: z.string().min(8).max(180),
};

export const openUploadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("asset"),
    ...common,
    category: z.string(),
    /** Advertiser and campaign, shown in the library. */
    metadata: z.record(z.string().max(200)).optional(),
  }),
  z.object({
    kind: z.literal("loop"),
    ...common,
    name: z.string(),
    /** "library" (kept off air), "all" (all cabs) or a group id. */
    target: z.string().min(1).max(100),
  }),
]);

export type OpenUpload = z.infer<typeof openUploadSchema>;

/** What the session keeps (the result is stored once finished, so a repeated "complete" gets it again). */
export type DesktopUploadData =
  | {
      kind: "asset";
      category: z.infer<typeof assetCategorySchema>;
      metadata: Record<string, string> | null;
      result?: { assetId: string; filename: string };
    }
  | {
      kind: "loop";
      name: string;
      target: DesktopUploadTarget;
      result?: { loopId: string };
    };

/** The checks a single-request upload made before reading the body, plus the size. */
export async function checkUploadDetails(body: OpenUpload): Promise<{ data: DesktopUploadData; tooLargeMessage: string }> {
  const extension = path.extname(body.fileName).toLowerCase();
  if (body.kind === "asset") {
    if (!assetKindOf(body.fileName)) throw new ApiError(assetLimitsMessage, 400);
    const category = assetCategorySchema.safeParse(body.category);
    if (!category.success) throw new ApiError("Choose a kind for the file.", 400);
    const metadata = Object.fromEntries(
      Object.entries(body.metadata ?? {})
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value.length > 0),
    );
    return {
      data: { kind: "asset", category: category.data, metadata: Object.keys(metadata).length ? metadata : null },
      tooLargeMessage: `Files are limited to ${megabytes} MB.`,
    };
  }
  const name = createLoopSchema.safeParse({ name: body.name.trim() });
  if (!name.success) throw new ApiError("Name must be between 2 and 120 characters.", 400, name.error.flatten());
  if (!(directLoopUploadExtensions as readonly string[]).includes(extension)) throw new ApiError(loopLimitsMessage, 400);
  let target: DesktopUploadTarget;
  if (body.target === "library") {
    target = { kind: "library" };
  } else if (body.target === "all") {
    target = { kind: "all" };
  } else {
    const group = await prisma.deviceGroup.findUnique({ where: { id: body.target }, select: { id: true } });
    if (!group) throw new ApiError("That group no longer exists.", 400);
    target = { kind: "group", groupId: group.id };
  }
  return { data: { kind: "loop", name: name.data.name, target }, tooLargeMessage: loopLimitsMessage };
}

/** A pre-built loop's first piece must start like an MP4/MOV, so a wrong file is refused before the rest is sent. */
export function pieceCheckFor(data: DesktopUploadData) {
  return async (index: number, filePath: string) => {
    if (data.kind === "loop" && index === 0 && !(await looksLikeIsoMediaFile(filePath))) {
      throw new ApiError(`This file is not a supported video. ${loopLimitsMessage}`, 415);
    }
  };
}

type Joined = { tempDir: string; filePath: string; meta: { fileName: string; data: DesktopUploadData } };

/**
 * The whole file is here: hand it to the same background processing the single-request uploads
 * used. Throws only before it has taken the temp folder (then the pieces are kept for a retry).
 */
export async function processJoinedUpload(file: Joined, user: { id: string; name: string }) {
  const { data } = file.meta;
  if (data.kind === "asset") {
    return { kind: "asset" as const, ...(await startAssetProcessing(file, data)) };
  }
  if (!(await looksLikeIsoMediaFile(file.filePath))) {
    throw new ApiError(`This file is not a supported video. ${loopLimitsMessage}`, 415);
  }
  const loop = await createPendingDesktopLoop({ name: data.name, target: data.target });
  startUploadedLoopProcessing({
    loopId: loop.id,
    originalFilename: file.meta.fileName,
    tempFilePath: file.filePath,
    tempDir: file.tempDir,
    publishedBy: { id: user.id, name: user.name },
    desktop: { target: data.target },
  });
  revalidatePath("/loops");
  return { kind: "loop" as const, loopId: loop.id };
}

async function startAssetProcessing(file: Joined, data: Extract<DesktopUploadData, { kind: "asset" }>) {
  const filename = file.meta.fileName;
  const kind = assetKindOf(filename);
  if (!kind) throw new ApiError(assetLimitsMessage, 400);
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
      category: data.category,
      metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      status: "PROCESSING",
    },
  });
  await logActivity("ASSET_UPLOADED", `Asset ${filename} uploaded`, { assetId: asset.id, category: asset.category });
  // Media jobs run in this process, one at a time; the temp folder is removed afterwards.
  void mediaJobLimiter()
    .run(() => processAssetUpload(asset.id, file.filePath))
    .catch((error) => console.error(`asset ${asset.id} processing crashed`, error))
    .finally(() => rm(file.tempDir, { recursive: true, force: true }).catch(() => undefined));
  revalidatePath("/assets");
  return { assetId: asset.id, filename };
}

export function storeResult(data: DesktopUploadData, result: Awaited<ReturnType<typeof processJoinedUpload>>): DesktopUploadData {
  if (data.kind === "asset" && result.kind === "asset") return { ...data, result: { assetId: result.assetId, filename: result.filename } };
  if (data.kind === "loop" && result.kind === "loop") return { ...data, result: { loopId: result.loopId } };
  return data;
}

export function readResult(data: DesktopUploadData): Awaited<ReturnType<typeof processJoinedUpload>> | null {
  if (data.kind === "asset" && data.result) return { kind: "asset", ...data.result };
  if (data.kind === "loop" && data.result) return { kind: "loop", ...data.result };
  return null;
}

export function sessionView(session: {
  id: string;
  size: number;
  pieceBytes: number;
  pieceCount: number;
  received: number[];
  receivedBytes: number;
  status: string;
  data: DesktopUploadData;
}) {
  return {
    uploadId: session.id,
    kind: session.data.kind,
    size: session.size,
    pieceBytes: session.pieceBytes,
    pieceCount: session.pieceCount,
    received: session.received,
    receivedBytes: session.receivedBytes,
    status: session.status,
    result: session.data.result ?? null,
  };
}
