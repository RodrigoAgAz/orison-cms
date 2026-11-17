import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { prisma } from "@orison/db";

import { logActivity } from "./activity";
import { ASSET_MAX_FRAME, aacArgs, h264Args, isHdrTransfer, videoFilter } from "./media-format";
import { deleteObject, putObjectFromFile } from "./storage";

const execFileAsync = promisify(execFile);

export type MediaMetadata = {
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  videoProfile?: string | null;
  audioCodec?: string | null;
  pixFmt?: string | null;
  colorTransfer?: string | null;
  /** Display rotation in degrees from the display matrix / rotate tag (0 when none). */
  rotation?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  audioChannels?: number | null;
  audioSampleRate?: number | null;
  /** Nominal (r_frame_rate) and average frame rate of the video stream. */
  frameRate?: number | null;
  avgFrameRate?: number | null;
  videoStartSeconds?: number | null;
  audioStartSeconds?: number | null;
  videoDurationMs?: number | null;
  audioDurationMs?: number | null;
};

export async function commandExists(command: string) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  start_time?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number | string }>;
};

async function ffprobe(filePath: string) {
  const isUrl = /^https?:\/\//.test(filePath);
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      // A signed object-storage URL: fail on a stalled connection instead of hanging.
      ...(isUrl ? ["-rw_timeout", "30000000"] : []),
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ],
    { timeout: 2 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
  );

  return JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { duration?: string } };
}

function readRotation(stream: { tags?: Record<string, string>; side_data_list?: Array<{ rotation?: number | string }> } | undefined) {
  const fromSideData = stream?.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation;
  const raw = fromSideData ?? stream?.tags?.rotate;
  const value = typeof raw === "number" ? raw : Number.parseFloat(raw ?? "0");
  return Number.isFinite(value) ? Math.round(value) % 360 : 0;
}

export function parseRate(value: string | undefined | null) {
  if (!value) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !denominator) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function seconds(value: string | undefined) {
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function extractMetadata(filePath: string): Promise<MediaMetadata> {
  if (!(await commandExists("ffprobe"))) {
    return {};
  }

  const result = await ffprobe(filePath);
  const videoStream = result.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = result.streams?.find((stream) => stream.codec_type === "audio");
  const videoDuration = seconds(videoStream?.duration);
  const audioDuration = seconds(audioStream?.duration);

  return {
    durationMs: result.format?.duration ? Math.round(Number.parseFloat(result.format.duration) * 1000) : undefined,
    width: videoStream?.width,
    height: videoStream?.height,
    videoCodec: videoStream?.codec_name,
    videoProfile: videoStream?.profile ?? null,
    audioCodec: audioStream?.codec_name,
    pixFmt: videoStream?.pix_fmt ?? null,
    colorTransfer: videoStream?.color_transfer ?? null,
    rotation: readRotation(videoStream),
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    audioChannels: audioStream?.channels ?? null,
    audioSampleRate: audioStream?.sample_rate ? Number.parseInt(audioStream.sample_rate, 10) : null,
    frameRate: parseRate(videoStream?.r_frame_rate),
    avgFrameRate: parseRate(videoStream?.avg_frame_rate),
    videoStartSeconds: seconds(videoStream?.start_time),
    audioStartSeconds: seconds(audioStream?.start_time),
    videoDurationMs: videoDuration === null ? null : Math.round(videoDuration * 1000),
    audioDurationMs: audioDuration === null ? null : Math.round(audioDuration * 1000),
  };
}

/** Video keyframe times in seconds (reads packets only, no decoding). */
export async function probeKeyframeTimes(filePath: string, timeoutMs = 5 * 60 * 1000) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", filePath],
    { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 },
  );
  const times: number[] = [];
  let packets = 0;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    packets += 1;
    const [time, flags] = line.split(",");
    if (flags?.includes("K")) times.push(Number.parseFloat(time));
  }
  return { keyframeSeconds: times.sort((a, b) => a - b), packets };
}

export function maxGapMs(times: number[], durationMs: number) {
  if (times.length === 0) return durationMs;
  let max = times[0] * 1000;
  for (let index = 1; index < times.length; index += 1) {
    max = Math.max(max, (times[index] - times[index - 1]) * 1000);
  }
  return Math.max(max, durationMs - times[times.length - 1] * 1000);
}

/**
 * Short human reason for a failed ffmpeg/ffprobe run. The full command and output go to the
 * server log only (they are 4-6 KB and mean nothing to staff).
 */
export function mediaFailureReason(error: unknown, fallback: string) {
  const text = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
  if (/Invalid data found when processing input|moov atom not found|could not find codec parameters/i.test(text)) {
    return "This file could not be read as a video or image. Try exporting it again as MP4, MOV, JPG or PNG.";
  }
  if (/killed|SIGKILL|SIGTERM|timed? ?out/i.test(text)) {
    return "Processing took too long and was stopped. Try a shorter or smaller file.";
  }
  if (/No space left/i.test(text)) {
    return "The server ran out of disk space while processing this file.";
  }
  return fallback;
}

async function runFfmpeg(args: string[], timeoutMs: number) {
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
}

let zscaleAvailable: Promise<boolean> | null = null;
/** HDR tone-mapping needs ffmpeg built with libzimg (zscale). */
export function hasZscaleFilter() {
  zscaleAvailable ??= execFileAsync("ffmpeg", ["-hide_banner", "-filters"])
    .then(({ stdout }) => /\bzscale\b/.test(stdout) && /\btonemap\b/.test(stdout))
    .catch(() => false);
  return zscaleAvailable;
}

/**
 * Library copy of an uploaded video: H.264 8-bit 4:2:0 SDR, upright, at most 1920x1080 (never
 * enlarged or padded, so a larger screen format can be targeted later), source frame timing,
 * AAC stereo 48 kHz when the source has sound (no sound track when it has none). Handles 10-bit
 * HEVC / HLG (iPhone), 4:2:2 and 4:4:4 sources.
 */
async function transcodeVideoAsset(inputPath: string, outputPath: string, metadata: MediaMetadata) {
  const hdr = isHdrTransfer(metadata.colorTransfer) && (await hasZscaleFilter());
  const fps = metadata.frameRate && metadata.frameRate > 60.5 ? 60 : null;
  const durationSeconds = (metadata.durationMs ?? 60_000) / 1000;
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      ...(metadata.hasAudio ? ["-map", "0:a:0"] : []),
      "-vf",
      videoFilter({ size: ASSET_MAX_FRAME, mode: "within", hdr, fps }),
      ...h264Args({ crf: 20 }),
      ...(metadata.hasAudio ? aacArgs() : ["-an"]),
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    Math.max(5 * 60 * 1000, durationSeconds * 20 * 1000),
  );
}

async function normalizeImage(inputPath: string, outputPath: string) {
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${ASSET_MAX_FRAME.width},iw)':'min(${ASSET_MAX_FRAME.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      "-q:v",
      "2",
      outputPath,
    ],
    2 * 60 * 1000,
  );
}

/** A still for the library, from the middle of very short clips, else at 2 s. */
async function generateThumbnail(inputPath: string, outputPath: string, durationMs: number | null | undefined) {
  const at = durationMs && durationMs < 4000 ? durationMs / 2000 : 2;
  await runFfmpeg(["-ss", at.toFixed(3), "-i", inputPath, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", outputPath], 2 * 60 * 1000);
}

export async function checksumFile(filePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return `sha256:${digest.digest("hex")}`;
}

/** Storage keys for a new asset: the extension follows what is stored, never the upload's name. */
export function assetKeysFor(assetId: string, kind: "video" | "image") {
  return kind === "video"
    ? { s3Key: `assets/${assetId}/content.mp4`, thumbnailKey: `assets/${assetId}/thumbnail.jpg` }
    : { s3Key: `assets/${assetId}/content.jpg`, thumbnailKey: null };
}

/**
 * Normalise an uploaded asset and store it. Never throws for bad input: the asset is marked
 * FAILED with a short reason (the ffmpeg detail goes to the server log). Removes `tempFilePath`.
 */
export async function processAssetUpload(assetId: string, tempFilePath: string) {
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orison-asset-"));
  const isVideo = asset.mimeType.startsWith("video/");
  const processedPath = path.join(tempDir, isVideo ? "asset.mp4" : "asset.jpg");
  const thumbnailPath = path.join(tempDir, "thumbnail.jpg");

  try {
    if (!(await commandExists("ffmpeg"))) {
      throw new Error("ffmpeg is not installed on the server");
    }
    let source: MediaMetadata;
    try {
      source = await extractMetadata(tempFilePath);
    } catch (error) {
      console.error(`asset ${asset.id}: ffprobe failed`, error);
      throw new AssetProcessingError("This file could not be read. Upload an MP4 or MOV video, or a JPG or PNG image.");
    }
    if (!source.hasVideo) {
      throw new AssetProcessingError("This file has no picture. Upload an MP4 or MOV video, or a JPG or PNG image.");
    }

    try {
      if (isVideo) {
        await transcodeVideoAsset(tempFilePath, processedPath, source);
      } else {
        await normalizeImage(tempFilePath, processedPath);
      }
    } catch (error) {
      console.error(`asset ${asset.id}: ffmpeg failed`, error);
      throw new AssetProcessingError(
        mediaFailureReason(error, "This file could not be converted. Try exporting it again as MP4 (H.264) or JPG."),
      );
    }

    const metadata = await extractMetadata(processedPath);
    if (asset.category === "SAFETY_MESSAGE" && isVideo && (metadata.durationMs ?? 0) > 30_000) {
      throw new AssetProcessingError("Safety message videos must be 30 seconds or shorter.");
    }

    let thumbnailKey: string | null = null;
    if (isVideo && asset.thumbnailKey) {
      try {
        await generateThumbnail(processedPath, thumbnailPath, metadata.durationMs);
        await putObjectFromFile({ key: asset.thumbnailKey, filePath: thumbnailPath, contentType: "image/jpeg" });
        thumbnailKey = asset.thumbnailKey;
      } catch (error) {
        console.warn(`asset ${asset.id}: no thumbnail`, error);
      }
    }

    const checksum = await checksumFile(processedPath);
    const processedStats = await stat(processedPath);
    await putObjectFromFile({ key: asset.s3Key, filePath: processedPath, contentType: isVideo ? "video/mp4" : "image/jpeg" });

    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        mimeType: isVideo ? "video/mp4" : "image/jpeg",
        // A still has no length of its own: it is shown for the time it is given.
        durationMs: isVideo ? metadata.durationMs ?? null : null,
        width: metadata.width ?? asset.width,
        height: metadata.height ?? asset.height,
        fileSize: processedStats.size,
        checksum,
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
    const reason =
      error instanceof AssetProcessingError ? error.message : "Processing failed unexpectedly. Try again, or try a different file.";
    if (!(error instanceof AssetProcessingError)) {
      console.error(`asset ${asset.id}: processing failed`, error);
    }
    await prisma.asset.update({
      where: { id: asset.id },
      data: { status: "FAILED", errorMessage: reason },
    });
    if (asset.thumbnailKey) {
      await deleteObject(asset.thumbnailKey).catch(() => undefined);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(tempFilePath, { force: true });
  }
}

export class AssetProcessingError extends Error {}
