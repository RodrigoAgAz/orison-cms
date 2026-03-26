import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { prisma, type Asset, type Loop, type Slot, type SlotContent } from "@orison/db";
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
  const loop = (await loadLoop(loopId)) as LoopWithContents | null;
  if (!loop) {
    throw new Error("Loop not found");
  }

  const sortedSlots = sortLoopContents(loop);
  const slots = sortedSlots.map((slot) => {
    const advertisement = slot.contents.find((content) => content.contentType === "ADVERTISEMENT");

    return {
      position: slot.position,
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
    publishedAt: new Date().toISOString(),
    totalDurationMs: loopDurationMs,
    slots,
    totalDownloadSizeBytes: sortedSlots.reduce(
      (total, slot) =>
        total +
        slot.contents.reduce((slotSum, content) => slotSum + content.asset.fileSize, 0) +
        (slot.staticCreative?.fileSize ?? 0),
      0,
    ),
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

async function transcodeCompiledLoopVideo(inputPath: string, outputPath: string) {
  await runFfmpeg([
    "-i",
    inputPath,
    "-vf",
    "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:black,fps=30",
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
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
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
    metadata.audioCodec === "aac"
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

export async function publishDirectLoopUpload({
  name,
  originalFilename,
  tempFilePath,
  publishedByUserId,
}: DirectLoopUploadOptions) {
  if (!(await commandExists("ffmpeg")) || !(await commandExists("ffprobe"))) {
    throw new Error("ffmpeg and ffprobe are required to publish direct loop uploads");
  }

  const uploadedFileStats = await stat(tempFilePath);
  if (uploadedFileStats.size > directLoopUploadMaxBytes) {
    throw new Error("Direct loop uploads are limited to 500MB");
  }

  const sourceMetadata = await extractMetadata(tempFilePath);
  if (!sourceMetadata.durationMs) {
    throw new Error("Unable to determine uploaded loop duration");
  }

  if (sourceMetadata.durationMs > directLoopUploadMaxDurationMs) {
    throw new Error("Direct loop uploads must be 14 minutes or shorter");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orison-direct-loop-"));
  const outputPath = path.join(tempDir, "loop.mp4");
  let compiledSourcePath = outputPath;
  let loop: Loop | null = null;
  let manifestKey: string | null = null;
  let compiledVideoKey: string | null = null;

  try {
    if (isDirectLoopAlreadyStandard(sourceMetadata)) {
      await remuxCompiledLoopVideo(tempFilePath, outputPath);
    } else {
      await transcodeCompiledLoopVideo(tempFilePath, outputPath);
    }

    const outputMetadata = await extractMetadata(compiledSourcePath);
    const durationMs = outputMetadata.durationMs ?? sourceMetadata.durationMs;
    if (!durationMs) {
      throw new Error("Unable to determine transcoded loop duration");
    }

    if (durationMs > directLoopUploadMaxDurationMs) {
      throw new Error("Direct loop uploads must be 14 minutes or shorter");
    }

    const outputStats = await stat(compiledSourcePath);
    const publishedAt = new Date();

    loop = await prisma.loop.create({
      data: {
        name,
        status: "DRAFT",
      },
    });

    manifestKey = `manifests/${loop.id}/${Date.now()}-${randomUUID()}.json`;
    compiledVideoKey = `loops/${loop.id}/${Date.now()}-${randomUUID()}.mp4`;

    const compiledVideoUrl = getPublicUrl(compiledVideoKey);
    const compiledVideoChecksum = await checksumFilePath(compiledSourcePath);
    const manifest = {
      version: "1.0",
      loopId: loop.id,
      loopName: loop.name,
      publishedAt: publishedAt.toISOString(),
      totalDurationMs: durationMs,
      slots: [],
      totalDownloadSizeBytes: outputStats.size,
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
      filePath: compiledSourcePath,
      contentType: "video/mp4",
    });

    await prisma.loop.update({
      where: { id: loop.id },
      data: {
        status: "PUBLISHED",
        publishedAt,
        publishedBy: publishedByUserId,
        manifestKey,
        manifestUrl: getPublicUrl(manifestKey),
        compiledVideoKey,
        compiledVideoUrl,
        checksum,
      },
    });

    await logActivity("LOOP_PUBLISHED", `Loop ${loop.name} published from direct upload`, {
      loopId: loop.id,
      publishedByUserId,
      checksum,
      compiledVideoKey,
      originalFilename,
      mode: "DIRECT_UPLOAD",
      fileSizeBytes: outputStats.size,
      durationMs,
    });

    return {
      loopId: loop.id,
      manifest: manifestWithChecksum,
      compiledVideoUrl,
      checksum,
      compiledVideoChecksum,
      fileSizeBytes: outputStats.size,
    };
  } catch (error) {
    if (manifestKey) {
      await deleteObject(manifestKey).catch(() => undefined);
    }
    if (compiledVideoKey) {
      await deleteObject(compiledVideoKey).catch(() => undefined);
    }
    if (loop) {
      await prisma.loop.delete({ where: { id: loop.id } }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
