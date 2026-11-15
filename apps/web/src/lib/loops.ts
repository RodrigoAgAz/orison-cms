import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { prisma, type Asset, type Loop, type Prisma, type Slot, type SlotContent } from "@orison/db";
import {
  advertisementDurationMs,
  directLoopUploadMaxBytes,
  directLoopUploadMaxDurationMs,
  loopDurationMs,
  slotDurationMs,
  type SlotContentInput,
} from "@orison/shared";
import { checksumJson } from "@orison/shared/src/manifest.server";

import { logActivity } from "./activity";
import { getCmsSettings } from "./cms-settings";
import { commandExists, extractMetadata } from "./media";
import {
  deleteObject,
  downloadObjectToFile,
  getPublicUrl,
  putObject,
  putObjectFromFile,
} from "./storage";

const execFileAsync = promisify(execFile);

type LoopWithContents = Loop & {
  slots: Array<
    Slot & {
      staticCreative?: Asset | null;
      contents: Array<SlotContent & { asset: Asset }>;
    }
  >;
};

type SafetyVideoManifestData = {
  url: string;
  checksum: string;
  durationMs: number;
  fileSizeBytes: number;
  mimeType: string;
};

type DirectLoopUploadOptions = {
  name: string;
  originalFilename: string;
  tempFilePath: string;
  publishedByUserId: string;
};

function sortLoopContents(loop: LoopWithContents) {
  return loop.slots
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((slot) => ({
      ...slot,
      contents: slot.contents.slice().sort((a, b) => a.orderInSlot - b.orderInSlot),
    }));
}

function validateDraftSlotContents(contents: SlotContentInput[]) {
  const sorted = contents.slice().sort((a, b) => a.startTimeMs - b.startTimeMs);
  const totalDuration = contents.reduce((sum, content) => sum + content.durationMs, 0);
  const advertisements = contents.filter((content) => content.contentType === "ADVERTISEMENT");

  if (advertisements.length > 1) {
    throw new Error("A slot can only contain one advertisement");
  }

  if (advertisements.some((content) => content.durationMs !== advertisementDurationMs)) {
    throw new Error(`Advertisement duration must be ${advertisementDurationMs}ms`);
  }

  if (totalDuration > slotDurationMs) {
    throw new Error(`Slot content cannot exceed ${slotDurationMs}ms`);
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];

    if (current.startTimeMs + current.durationMs > slotDurationMs) {
      throw new Error("Slot content exceeds the 60 second slot duration");
    }

    if (next && current.startTimeMs + current.durationMs > next.startTimeMs) {
      throw new Error("Slot contents overlap");
    }
  }

  return sorted;
}

export function validateSlotContents(contents: SlotContentInput[]) {
  const sorted = validateDraftSlotContents(contents);
  const totalDuration = contents.reduce((sum, content) => sum + content.durationMs, 0);
  const advertisements = contents.filter((content) => content.contentType === "ADVERTISEMENT");
  if (totalDuration !== slotDurationMs) {
    throw new Error(`Slot must total exactly ${slotDurationMs}ms`);
  }

  if (advertisements.length !== 1) {
    throw new Error("Each slot must contain exactly one advertisement");
  }

  return sorted;
}

export async function createLoopDraft(name: string) {
  return prisma.$transaction(async (tx) => {
    const loop = await tx.loop.create({
      data: {
        name,
        status: "DRAFT",
      },
    });

    await tx.slot.createMany({
      data: Array.from({ length: 10 }, (_, position) => ({
        loopId: loop.id,
        position,
      })),
    });

    await logActivity("LOOP_CREATED", `Loop ${name} created`, { loopId: loop.id, name });

    return tx.loop.findUniqueOrThrow({
      where: { id: loop.id },
      include: {
        slots: {
          orderBy: { position: "asc" },
        },
      },
    });
  });
}

export async function duplicateLoop(loopId: string) {
  const existing = await prisma.loop.findUnique({
    where: { id: loopId },
    include: {
      slots: {
        orderBy: { position: "asc" },
        include: {
          contents: {
            orderBy: { orderInSlot: "asc" },
          },
        },
      },
    },
  });

  if (!existing) {
    throw new Error("Loop not found");
  }

  return prisma.$transaction(async (tx) => {
    const duplicated = await tx.loop.create({
      data: {
        name: `${existing.name} Copy`,
        status: "DRAFT",
      },
    });

    for (const slot of existing.slots) {
      const newSlot = await tx.slot.create({
        data: {
          loopId: duplicated.id,
          position: slot.position,
          staticCreativeId: slot.staticCreativeId,
        },
      });

      if (slot.contents.length > 0) {
        await tx.slotContent.createMany({
          data: slot.contents.map((content) => ({
            slotId: newSlot.id,
            assetId: content.assetId,
            orderInSlot: content.orderInSlot,
            startTimeMs: content.startTimeMs,
            durationMs: content.durationMs,
            contentType: content.contentType,
          })),
        });
      }
    }

    return duplicated;
  });
}

export async function loadLoop(loopId: string) {
  return prisma.loop.findUnique({
    where: { id: loopId },
    include: {
      slots: {
        orderBy: { position: "asc" },
        include: {
          staticCreative: true,
          contents: {
            orderBy: { orderInSlot: "asc" },
            include: {
              asset: true,
            },
          },
        },
      },
    },
  });
}

export async function updateSlotContents(
  loopId: string,
  position: number,
  contents: SlotContentInput[],
  staticCreativeId?: string | null,
) {
  validateDraftSlotContents(contents);

  const slot = await prisma.slot.findUnique({
    where: {
      loopId_position: {
        loopId,
        position,
      },
    },
  });

  if (!slot) {
    throw new Error("Slot not found");
  }

  const assetIds = [...new Set(contents.map((content) => content.assetId))];
  const assets = await prisma.asset.findMany({
    where: {
      id: { in: assetIds },
      status: "READY",
    },
  });

  if (assets.length !== assetIds.length) {
    throw new Error("All slot assets must exist and be in READY state");
  }

  if (staticCreativeId) {
    const staticCreative = await prisma.asset.findUnique({
      where: { id: staticCreativeId },
    });

    if (!staticCreative || staticCreative.status !== "READY" || staticCreative.category !== "STATIC_CREATIVE") {
      throw new Error("Static creative must exist, be ready, and use the STATIC_CREATIVE category");
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.slot.update({
      where: { id: slot.id },
      data: {
        staticCreativeId: staticCreativeId ?? null,
      },
    });

    await tx.slotContent.deleteMany({
      where: { slotId: slot.id },
    });

    await tx.slotContent.createMany({
      data: contents.map((content) => ({
        slotId: slot.id,
        assetId: content.assetId,
        orderInSlot: content.orderInSlot,
        startTimeMs: content.startTimeMs,
        durationMs: content.durationMs,
        contentType: content.contentType,
      })),
    });
  });

  return loadLoop(loopId);
}

export async function buildPreviewManifest(loopId: string) {
  const [loop, safetyVideo] = await Promise.all([
    loadLoop(loopId) as Promise<LoopWithContents | null>,
    loadSafetyVideoManifestData(),
  ]);
  if (!loop) {
    throw new Error("Loop not found");
  }

  const sortedSlots = sortLoopContents(loop);
  const slots = sortedSlots.map((slot) => {
    const advertisement = slot.contents.find((content) => content.contentType === "ADVERTISEMENT");

    return {
      position: slot.position,
      staticImageAssetId: slot.staticCreativeId ?? null,
      staticImageUrl: slot.staticCreative ? getPublicUrl(slot.staticCreative.s3Key) : null,
      staticImageChecksum: slot.staticCreative?.checksum ?? null,
      advertisementVideoUrl: advertisement ? getPublicUrl(advertisement.asset.s3Key) : null,
      contents: slot.contents.map((content) => ({
        type: content.contentType,
        assetId: content.assetId,
        filename: content.asset.filename,
        url: getPublicUrl(content.asset.s3Key),
        checksum: content.asset.checksum ?? "",
        startTimeMs: content.startTimeMs,
        durationMs: content.durationMs,
        fileSizeBytes: content.asset.fileSize,
      })),
    };
  });

  const manifest = {
    version: "1.0",
    loopId: loop.id,
    loopName: loop.name,
    targetGroupId: loop.targetGroupId ?? null,
    publishedAt: new Date().toISOString(),
    totalDurationMs: loopDurationMs,
    safetyVideo:
      safetyVideo && safetyVideo.durationMs > 0
        ? {
            url: safetyVideo.url,
            checksum: safetyVideo.checksum,
            durationMs: safetyVideo.durationMs,
            mimeType: safetyVideo.mimeType,
          }
        : undefined,
    slots,
    totalDownloadSizeBytes: sortedSlots.reduce(
      (total, slot) =>
        total +
        slot.contents.reduce((slotSum, content) => slotSum + content.asset.fileSize, 0) +
        (slot.staticCreative?.fileSize ?? 0),
      0,
    ) + (safetyVideo?.fileSizeBytes ?? 0),
    compiledVideoUrl: loop.compiledVideoUrl,
    compiledVideoChecksum: null,
  };

  return {
    ...manifest,
    checksum: checksumJson(manifest),
  };
}

async function ensureLoopPublishable(loop: LoopWithContents) {
  const sortedSlots = sortLoopContents(loop);
  if (sortedSlots.length !== 10) {
    throw new Error("Loop must contain exactly 10 slots");
  }

  for (const slot of sortedSlots) {
    if (slot.contents.length === 0) {
      throw new Error(`Slot ${slot.position + 1} is empty`);
    }

    validateSlotContents(
      slot.contents.map((content) => ({
        assetId: content.assetId,
        orderInSlot: content.orderInSlot,
        startTimeMs: content.startTimeMs,
        durationMs: content.durationMs,
        contentType: content.contentType,
      })),
    );

    if (slot.contents.some((content) => content.asset.status !== "READY")) {
      throw new Error(`Slot ${slot.position + 1} contains assets that are not ready`);
    }
  }
}

async function loadSafetyVideoManifestData(): Promise<SafetyVideoManifestData | null> {
  const settings = await getCmsSettings();
  if (!settings.safetyVideoAssetId) {
    return null;
  }

  const asset = await prisma.asset.findUnique({
    where: { id: settings.safetyVideoAssetId },
  });

  if (
    !asset ||
    asset.status !== "READY" ||
    asset.category !== "SAFETY_MESSAGE" ||
    !asset.mimeType
  ) {
    return null;
  }

  const durationMs = asset.mimeType.startsWith("image/")
    ? settings.safetyMessageDurationSeconds * 1000
    : asset.durationMs ?? 0;

  if (durationMs <= 0) {
    return null;
  }

  return {
    url: getPublicUrl(asset.s3Key),
    checksum: asset.checksum ?? "",
    durationMs,
    fileSizeBytes: asset.fileSize,
    mimeType: asset.mimeType,
  };
}

async function runFfmpeg(args: string[]) {
  await execFileAsync("ffmpeg", ["-y", ...args]);
}

async function normalizeImageToClip(
  inputPath: string,
  outputPath: string,
  durationMs: number,
) {
  await runFfmpeg([
    "-loop",
    "1",
    "-i",
    inputPath,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest",
    "-t",
    (durationMs / 1000).toFixed(3),
    "-vf",
    "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:black,fps=30",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

const LOOP_FRAME_FILTER =
  "scale=1280:800:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1," +
  "pad=1280:800:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p";
// HDR (iPhone HLG / PQ) -> SDR BT.709 before scaling; requires ffmpeg built with libzimg.
const HDR_TONEMAP_FILTER =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0," +
  "zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

let zscaleAvailable: Promise<boolean> | null = null;
function hasZscaleFilter() {
  zscaleAvailable ??= execFileAsync("ffmpeg", ["-hide_banner", "-filters"])
    .then(({ stdout }) => /\bzscale\b/.test(stdout) && /\btonemap\b/.test(stdout))
    .catch(() => false);
  return zscaleAvailable;
}

function isHdrTransfer(transfer: string | null | undefined) {
  return transfer === "smpte2084" || transfer === "arib-std-b67";
}

/**
 * Normalise any input (mp4/mov/m4v, H.264/HEVC, 8/10-bit, portrait, rotated) to the standard loop
 * format: 1280x800 H.264 High 4.1 yuv420p, 30fps, AAC 44.1kHz, faststart. The picture is fitted
 * inside 1280x800 and letter/pillarboxed (never stretched). ffmpeg applies display rotation
 * (autorotate) before the filter chain, so portrait/rotated phone footage is fitted upright.
 */
async function transcodeCompiledLoopVideo(
  inputPath: string,
  outputPath: string,
  metadata?: Awaited<ReturnType<typeof extractMetadata>>,
) {
  const tonemap = isHdrTransfer(metadata?.colorTransfer) && (await hasZscaleFilter());
  const filter = tonemap ? `${HDR_TONEMAP_FILTER},${LOOP_FRAME_FILTER}` : LOOP_FRAME_FILTER;
  await runFfmpeg([
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function generateFallbackStaticImage(outputPath: string) {
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x0a1628:s=1280x800",
    "-frames:v",
    "1",
    "-vf",
    "drawbox=x=120:y=120:w=1040:h=560:color=0xc9a84c:t=12",
    outputPath,
  ]);
}

async function remuxCompiledLoopVideo(inputPath: string, outputPath: string) {
  await runFfmpeg([
    "-i",
    inputPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

function isDirectLoopAlreadyStandard(metadata: Awaited<ReturnType<typeof extractMetadata>>) {
  return (
    metadata.width === 1280 &&
    metadata.height === 800 &&
    metadata.videoCodec === "h264" &&
    metadata.audioCodec === "aac" &&
    (metadata.pixFmt ?? "yuv420p") === "yuv420p" &&
    !metadata.rotation &&
    !isHdrTransfer(metadata.colorTransfer)
  );
}

async function compileSingleFileLoop(loop: LoopWithContents) {
  if (!(await commandExists("ffmpeg"))) {
    throw new Error("ffmpeg is required to publish compiled loops");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orison-loop-"));

  try {
    const playlistPath = path.join(tempDir, "playlist.txt");
    const outputPath = path.join(tempDir, `${loop.id}.mp4`);
    const playlistEntries: string[] = [];
    let sequence = 0;

    for (const slot of sortLoopContents(loop)) {
      for (const content of slot.contents) {
        const sourceExtension = path.extname(content.asset.filename) || ".bin";
        const sourcePath = path.join(tempDir, `${sequence}${sourceExtension}`);
        await downloadObjectToFile(content.asset.s3Key, sourcePath);

        let mediaPath = sourcePath;
        if (content.asset.mimeType.startsWith("image/")) {
          mediaPath = path.join(tempDir, `${sequence}.mp4`);
          await normalizeImageToClip(sourcePath, mediaPath, content.durationMs);
        }

        playlistEntries.push(`file '${mediaPath.replace(/'/g, "'\\''")}'`);
        sequence += 1;
      }
    }

    await writeFile(playlistPath, playlistEntries.join("\n"));
    await runFfmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      playlistPath,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);

    return {
      outputPath,
      tempDir,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function checksumFilePath(filePath: string) {
  const digest = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }

  return `sha256:${digest.digest("hex")}`;
}

export async function publishLoop(loopId: string, publishedByUserId: string) {
  const loop = (await loadLoop(loopId)) as LoopWithContents | null;
  if (!loop) {
    throw new Error("Loop not found");
  }

  await ensureLoopPublishable(loop);
  const manifestDraft = await buildPreviewManifest(loop.id);
  const manifestKey = `manifests/${loop.id}/${Date.now()}-${randomUUID()}.json`;
  const compiledVideoKey = `loops/${loop.id}/${Date.now()}-${randomUUID()}.mp4`;
  const compileResult = await compileSingleFileLoop(loop);
  const fallbackStaticPath = path.join(compileResult.tempDir, "fallback-static.jpg");
  const fallbackStaticKey = `loops/${loop.id}/${Date.now()}-${randomUUID()}-static-fallback.jpg`;

  try {
    const compiledStats = await stat(compileResult.outputPath);
    const compiledVideoUrl = getPublicUrl(compiledVideoKey);
    const compiledVideoChecksum = await checksumFilePath(compileResult.outputPath);
    await generateFallbackStaticImage(fallbackStaticPath);
    const fallbackStaticUrl = getPublicUrl(fallbackStaticKey);
    const fallbackStaticChecksum = await checksumFilePath(fallbackStaticPath);
    const manifest = {
      ...manifestDraft,
      slots: manifestDraft.slots.map((slot) => ({
        ...slot,
        staticImageUrl: slot.staticImageUrl ?? fallbackStaticUrl,
        staticImageChecksum: slot.staticImageChecksum ?? fallbackStaticChecksum,
      })),
      compiledVideoUrl,
      compiledVideoChecksum,
    };
    const checksum = checksumJson(manifest);
    const manifestWithChecksum = {
      ...manifest,
      checksum,
    };

    await putObject({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifestWithChecksum, null, 2)),
      contentType: "application/json",
    });
    await putObjectFromFile({
      key: compiledVideoKey,
      filePath: compileResult.outputPath,
      contentType: "video/mp4",
    });
    await putObjectFromFile({
      key: fallbackStaticKey,
      filePath: fallbackStaticPath,
      contentType: "image/jpeg",
    });

    await prisma.loop.update({
      where: { id: loop.id },
      data: {
        status: "PUBLISHED",
        version: { increment: 1 },
        publishedAt: new Date(),
        publishedBy: publishedByUserId,
        publishError: null,
        manifestKey,
        manifestUrl: getPublicUrl(manifestKey),
        compiledVideoKey,
        compiledVideoUrl,
        checksum,
        durationMs: loopDurationMs,
        // The compiled video changed; the poster is regenerated lazily.
        posterKey: null,
      },
    });

    await logActivity("LOOP_PUBLISHED", `Loop ${loop.name} published`, {
      loopId: loop.id,
      publishedByUserId,
      checksum,
      compiledVideoKey,
    });

    return {
      manifest: manifestWithChecksum,
      compiledVideoUrl,
      checksum,
      compiledVideoChecksum,
      fileSizeBytes: compiledStats.size,
    };
  } catch (error) {
    await deleteObject(manifestKey).catch(() => undefined);
    await deleteObject(compiledVideoKey).catch(() => undefined);
    await deleteObject(fallbackStaticKey).catch(() => undefined);
    throw error;
  } finally {
    await rm(compileResult.tempDir, { recursive: true, force: true });
  }
}

export const directLoopUploadExtensions = [".mp4", ".mov", ".m4v"] as const;

/** Human-readable reason, safe to show to phone users. */
export class LoopUploadError extends Error {}

type PreparedLoopVideo = {
  outputPath: string;
  durationMs: number;
  fileSizeBytes: number;
};

/**
 * Validate an uploaded file and produce the standard compiled loop video inside `workDir`.
 * Throws LoopUploadError with a user-facing message for bad input.
 */
async function prepareLoopVideo(tempFilePath: string, workDir: string): Promise<PreparedLoopVideo> {
  if (!(await commandExists("ffmpeg")) || !(await commandExists("ffprobe"))) {
    throw new Error("ffmpeg and ffprobe are required to publish direct loop uploads");
  }

  const uploadedFileStats = await stat(tempFilePath);
  if (uploadedFileStats.size === 0) {
    throw new LoopUploadError("The uploaded file is empty");
  }
  if (uploadedFileStats.size > directLoopUploadMaxBytes) {
    throw new LoopUploadError("Direct loop uploads are limited to 500MB");
  }

  let sourceMetadata: Awaited<ReturnType<typeof extractMetadata>>;
  try {
    sourceMetadata = await extractMetadata(tempFilePath);
  } catch {
    throw new LoopUploadError("This file could not be read as a video. Upload an MP4 or MOV file.");
  }
  if (!sourceMetadata.hasVideo) {
    throw new LoopUploadError("This file does not contain a video track");
  }
  if (!sourceMetadata.durationMs) {
    throw new LoopUploadError("Unable to determine uploaded loop duration");
  }
  if (sourceMetadata.durationMs > directLoopUploadMaxDurationMs) {
    throw new LoopUploadError("Direct loop uploads must be 14 minutes or shorter");
  }

  const outputPath = path.join(workDir, "loop.mp4");
  try {
    if (isDirectLoopAlreadyStandard(sourceMetadata)) {
      await remuxCompiledLoopVideo(tempFilePath, outputPath);
    } else {
      await transcodeCompiledLoopVideo(tempFilePath, outputPath, sourceMetadata);
    }
  } catch (error) {
    console.error("loop transcode failed", error);
    throw new LoopUploadError("The video could not be converted. Try exporting it again as MP4 or MOV.");
  }

  const outputMetadata = await extractMetadata(outputPath);
  const durationMs = outputMetadata.durationMs ?? sourceMetadata.durationMs;
  if (!durationMs) {
    throw new LoopUploadError("Unable to determine transcoded loop duration");
  }
  if (durationMs > directLoopUploadMaxDurationMs) {
    throw new LoopUploadError("Direct loop uploads must be 14 minutes or shorter");
  }

  const outputStats = await stat(outputPath);
  return { outputPath, durationMs, fileSizeBytes: outputStats.size };
}

/** Extract a JPEG still (640px wide) from a compiled loop video. */
export async function generatePosterImage(videoPath: string, outputPath: string, durationMs?: number | null) {
  const seekSeconds = durationMs && durationMs < 2000 ? (durationMs / 2000).toFixed(2) : "1";
  await runFfmpeg([
    "-ss",
    seekSeconds,
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    "-q:v",
    "4",
    outputPath,
  ]);
}

/**
 * Upload the compiled video, manifest and poster for an existing Loop row and mark it PUBLISHED.
 * Cleans up uploaded objects if anything fails.
 */
async function publishPreparedLoopVideo(options: {
  loop: Loop;
  prepared: PreparedLoopVideo;
  workDir: string;
  publishedByUserId: string;
  activity: { message: string; metadata: Record<string, unknown> };
}) {
  const { loop, prepared, workDir, publishedByUserId } = options;
  const safetyVideo = await loadSafetyVideoManifestData();
  const stamp = `${Date.now()}-${randomUUID()}`;
  const manifestKey = `manifests/${loop.id}/${stamp}.json`;
  const compiledVideoKey = `loops/${loop.id}/${stamp}.mp4`;
  const posterKey = `loops/${loop.id}/${stamp}-poster.jpg`;
  const posterPath = path.join(workDir, "poster.jpg");
  const publishedAt = new Date();

  try {
    const compiledVideoUrl = getPublicUrl(compiledVideoKey);
    const compiledVideoChecksum = await checksumFilePath(prepared.outputPath);
    const manifest = {
      version: "1.0",
      loopId: loop.id,
      loopName: loop.name,
      targetGroupId: loop.targetGroupId ?? null,
      publishedAt: publishedAt.toISOString(),
      totalDurationMs: prepared.durationMs,
      safetyVideo:
        safetyVideo && safetyVideo.durationMs > 0
          ? {
              url: safetyVideo.url,
              checksum: safetyVideo.checksum,
              durationMs: safetyVideo.durationMs,
              mimeType: safetyVideo.mimeType,
            }
          : undefined,
      slots: [],
      totalDownloadSizeBytes: prepared.fileSizeBytes + (safetyVideo?.fileSizeBytes ?? 0),
      compiledVideoUrl,
      compiledVideoChecksum,
    };
    const checksum = checksumJson(manifest);
    const manifestWithChecksum = { ...manifest, checksum };

    await putObject({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifestWithChecksum, null, 2)),
      contentType: "application/json",
    });
    await putObjectFromFile({ key: compiledVideoKey, filePath: prepared.outputPath, contentType: "video/mp4" });

    let storedPosterKey: string | null = null;
    try {
      await generatePosterImage(prepared.outputPath, posterPath, prepared.durationMs);
      await putObjectFromFile({ key: posterKey, filePath: posterPath, contentType: "image/jpeg" });
      storedPosterKey = posterKey;
    } catch (error) {
      // Poster is generated lazily later if this fails.
      console.warn(`poster generation failed for loop ${loop.id}`, error);
    }

    await prisma.loop.update({
      where: { id: loop.id },
      data: {
        status: "PUBLISHED",
        publishedAt,
        publishedBy: publishedByUserId,
        publishError: null,
        manifestKey,
        manifestUrl: getPublicUrl(manifestKey),
        compiledVideoKey,
        compiledVideoUrl,
        checksum,
        durationMs: prepared.durationMs,
        posterKey: storedPosterKey,
      },
    });

    await logActivity("LOOP_PUBLISHED", options.activity.message, {
      loopId: loop.id,
      publishedByUserId,
      checksum,
      compiledVideoKey,
      fileSizeBytes: prepared.fileSizeBytes,
      durationMs: prepared.durationMs,
      ...options.activity.metadata,
    } as Prisma.InputJsonObject);

    return {
      loopId: loop.id,
      manifest: manifestWithChecksum,
      compiledVideoUrl,
      checksum,
      compiledVideoChecksum,
      fileSizeBytes: prepared.fileSizeBytes,
    };
  } catch (error) {
    await deleteObject(manifestKey).catch(() => undefined);
    await deleteObject(compiledVideoKey).catch(() => undefined);
    await deleteObject(posterKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Desktop direct upload: synchronous, .mp4, creates the loop and makes it live fleet-wide
 * (autoLive defaults to true) once published. Behaviour unchanged from before the refactor.
 */
export async function publishDirectLoopUpload({
  name,
  originalFilename,
  tempFilePath,
  publishedByUserId,
}: DirectLoopUploadOptions) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-direct-loop-"));
  let loop: Loop | null = null;

  try {
    const prepared = await prepareLoopVideo(tempFilePath, workDir);
    loop = await prisma.loop.create({ data: { name, status: "DRAFT" } });
    return await publishPreparedLoopVideo({
      loop,
      prepared,
      workDir,
      publishedByUserId,
      activity: {
        message: `Loop ${loop.name} published from direct upload`,
        metadata: { originalFilename, mode: "DIRECT_UPLOAD" },
      },
    });
  } catch (error) {
    if (loop) {
      await prisma.loop.delete({ where: { id: loop.id } }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Phone uploads still PUBLISHING after this long are treated as failed (e.g. server restart). */
export const STALE_PUBLISHING_MS = 30 * 60 * 1000;
export const STALE_PUBLISHING_MESSAGE = "Processing was interrupted. Please upload the video again.";

/** Create the Loop row for a phone upload (PUBLISHING, autoLive false) before processing. */
export async function createPendingUploadLoop(options: {
  name: string;
  pendingTarget: Prisma.InputJsonValue | null;
}) {
  return prisma.loop.create({
    data: {
      name: options.name,
      status: "PUBLISHING",
      autoLive: false,
      pendingTarget: options.pendingTarget ?? undefined,
    },
  });
}

/**
 * Run the upload pipeline for a pre-created Loop row. Never throws: failures are written to
 * `publishError` (status DRAFT). The temp directory is always removed. `onPublished` runs after
 * a successful publish (used to apply the requested assignment target).
 */
export async function processUploadedLoop(options: {
  loopId: string;
  originalFilename: string;
  tempFilePath: string;
  tempDir: string;
  publishedByUserId: string;
  onPublished?: (loop: Loop) => Promise<void>;
}) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-mobile-loop-")).catch(() => null);
  try {
    if (!workDir) {
      throw new Error("Could not create a working directory");
    }
    const loop = await prisma.loop.findUnique({ where: { id: options.loopId } });
    if (!loop) {
      return;
    }
    const prepared = await prepareLoopVideo(options.tempFilePath, workDir);
    await publishPreparedLoopVideo({
      loop,
      prepared,
      workDir,
      publishedByUserId: options.publishedByUserId,
      activity: {
        message: `Loop ${loop.name} uploaded from the mobile app`,
        metadata: { originalFilename: options.originalFilename, mode: "MOBILE_UPLOAD" },
      },
    });
    if (options.onPublished) {
      const published = await prisma.loop.findUniqueOrThrow({ where: { id: loop.id } });
      try {
        await options.onPublished(published);
      } catch (error) {
        console.error(`post-publish step failed for loop ${loop.id}`, error);
        await prisma.loop
          .update({
            where: { id: loop.id },
            data: {
              publishError: `Uploaded, but could not be put live: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            },
          })
          .catch(() => undefined);
      }
    }
  } catch (error) {
    const message =
      error instanceof LoopUploadError
        ? error.message
        : "Processing failed unexpectedly. Please try again or use a different file.";
    if (!(error instanceof LoopUploadError)) {
      console.error(`loop upload ${options.loopId} failed`, error);
    }
    await prisma.loop
      .update({ where: { id: options.loopId }, data: { status: "DRAFT", publishError: message } })
      .catch((updateError) => console.error("could not record upload failure", updateError));
    await logActivity("LOOP_UPLOAD_FAILED", `Upload of loop ${options.loopId} failed: ${message}`, {
      loopId: options.loopId,
      originalFilename: options.originalFilename,
    }).catch(() => undefined);
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(options.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Fire-and-forget wrapper (long-lived Node server). */
export function startUploadedLoopProcessing(options: Parameters<typeof processUploadedLoop>[0]) {
  void processUploadedLoop(options).catch((error) => console.error("unhandled upload pipeline error", error));
}

/**
 * Lazily create (and cache in storage) a poster JPEG for a loop with a compiled video.
 * Returns the storage key, or null if the loop has no video.
 */
export async function ensureLoopPoster(loopId: string): Promise<string | null> {
  const loop = await prisma.loop.findUnique({
    where: { id: loopId },
    select: { id: true, posterKey: true, compiledVideoKey: true, durationMs: true },
  });
  if (!loop?.compiledVideoKey) {
    return null;
  }
  if (loop.posterKey) {
    return loop.posterKey;
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-poster-"));
  try {
    const videoPath = path.join(workDir, "loop.mp4");
    const posterPath = path.join(workDir, "poster.jpg");
    await downloadObjectToFile(loop.compiledVideoKey, videoPath);
    let durationMs = loop.durationMs;
    if (!durationMs) {
      durationMs = (await extractMetadata(videoPath)).durationMs ?? null;
    }
    await generatePosterImage(videoPath, posterPath, durationMs);
    const posterKey = `loops/${loop.id}/${Date.now()}-${randomUUID()}-poster.jpg`;
    await putObjectFromFile({ key: posterKey, filePath: posterPath, contentType: "image/jpeg" });
    await prisma.loop.update({
      where: { id: loop.id },
      data: { posterKey, ...(loop.durationMs ? {} : durationMs ? { durationMs } : {}) },
    });
    return posterKey;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
