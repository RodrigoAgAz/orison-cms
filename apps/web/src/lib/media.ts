import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { prisma } from "@orison/db";

import { logActivity } from "./activity";
import { putObject } from "./storage";

const execFileAsync = promisify(execFile);

type MediaMetadata = {
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
};

export async function commandExists(command: string) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function ffprobe(filePath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);

  return JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
    format?: {
      duration?: string;
    };
  };
}

export async function extractMetadata(
  filePath: string,
): Promise<MediaMetadata> {
  if (!(await commandExists("ffprobe"))) {
    return {};
  }

  const result = await ffprobe(filePath);
  const videoStream = result.streams?.find((stream) => stream.codec_type === "video");

  return {
    durationMs: result.format?.duration
      ? Math.round(Number.parseFloat(result.format.duration) * 1000)
      : undefined,
    width: videoStream?.width,
    height: videoStream?.height,
  };
}

async function runFfmpeg(args: string[]) {
  await execFileAsync("ffmpeg", ["-y", ...args]);
}

async function transcodeVideo(inputPath: string, outputPath: string) {
  await runFfmpeg([
    "-i",
    inputPath,
    "-vf",
    "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:black,fps=30",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
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

async function generateThumbnail(inputPath: string, outputPath: string) {
  await runFfmpeg([
    "-ss",
    "00:00:02",
    "-i",
    inputPath,
    "-vframes",
    "1",
    "-vf",
    "scale=640:-1",
    outputPath,
  ]);
}

async function checksumFile(filePath: string) {
  const buffer = await readFile(filePath);
  return {
    buffer,
    checksum: `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
  };
}

export async function processAssetUpload(assetId: string, tempFilePath: string) {
  const asset = await prisma.asset.findUniqueOrThrow({
    where: { id: assetId },
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orison-asset-"));
  const ffmpegAvailable = await commandExists("ffmpeg");
  const processedPath = path.join(
    tempDir,
    asset.mimeType.startsWith("video/") ? "asset.mp4" : path.basename(asset.filename),
  );
  const thumbnailPath = path.join(tempDir, "thumbnail.jpg");

  try {
    let outputPath = tempFilePath;
    let outputMimeType = asset.mimeType;

    if (asset.mimeType.startsWith("video/") && ffmpegAvailable) {
      await transcodeVideo(tempFilePath, processedPath);
      await generateThumbnail(tempFilePath, thumbnailPath);
      outputPath = processedPath;
      outputMimeType = "video/mp4";
    }

    const metadata = await extractMetadata(outputPath);
    const upload = await checksumFile(outputPath);
    await putObject({
      key: asset.s3Key,
      body: upload.buffer,
      contentType: outputMimeType,
    });

    let thumbnailKey = asset.thumbnailKey;
    if (asset.mimeType.startsWith("video/") && ffmpegAvailable) {
      const thumbnail = await stat(thumbnailPath).then(
        async () => readFile(thumbnailPath),
        async () => null,
      );

      if (thumbnail && asset.thumbnailKey) {
        await putObject({
          key: asset.thumbnailKey,
          body: thumbnail,
          contentType: "image/jpeg",
        });
      }
    } else {
      thumbnailKey = null;
    }

    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        mimeType: outputMimeType,
        durationMs: metadata.durationMs ?? asset.durationMs,
        width: metadata.width ?? asset.width,
        height: metadata.height ?? asset.height,
        fileSize: upload.buffer.byteLength,
        checksum: upload.checksum,
        thumbnailKey,
        status: "READY",
        errorMessage: null,
      },
    });

    await logActivity("ASSET_READY", `Asset ${asset.filename} is ready`, {
      assetId: asset.id,
      filename: asset.filename,
    });
  } catch (error) {
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown processing error",
      },
    });
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(tempFilePath, { force: true });
  }
}

