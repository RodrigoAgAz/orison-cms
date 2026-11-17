// Carries out a compile plan (lib/loop-plan.ts) with ffmpeg.
//
// 1. Each distinct asset is fetched once.
// 2. Each distinct segment (asset x number of frames) is encoded once, straight to the final
//    format: H.264 (identical stream headers for every segment, a keyframe on its first frame and
//    at least every 2 s) with exactly its number of frames, cut or held on its last frame; and its
//    sound as raw PCM, stereo 48 kHz, with exactly 1600 samples per frame (silence where the source
//    has none or ends early).
// 3. The segments' pictures are joined without re-encoding (concat demuxer, stream copy), the
//    PCM is joined byte for byte and encoded to AAC once, and both are muxed. So the picture is
//    encoded once per distinct segment (an advert used in ten slots once), and the sound is one
//    continuous stream whose every item lines up with its picture.
// 4. The output is measured with ffprobe and checked against the plan; a mismatch refuses the
//    publish.

import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  KEYFRAME_INTERVAL_FRAMES,
  verifyCompiled,
  type CompilePlan,
  type CompiledProbe,
  type PlanSegment,
} from "./loop-plan";
import { aacArgs, exactAudioFilter, h264Args, isHdrTransfer, videoFilter } from "./media-format";
import { extractMetadata, hasZscaleFilter, mediaFailureReason, probeKeyframeTimes, type MediaMetadata } from "./media";
import { LOOP_FPS } from "./slot-rules";
import { downloadObjectToFile } from "./storage";

const execFileAsync = promisify(execFile);

export class CompileError extends Error {}

export type CompileProgress = (stage: "fetching" | "encoding" | "assembling" | "checking", done: number, total: number) => void;

async function ffmpeg(args: string[], timeoutMs: number) {
  try {
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    console.error("ffmpeg failed:", ["ffmpeg", ...args].join(" "), error);
    throw error;
  }
}

/** The avcC box (H.264 stream headers) of an MP4 written with +faststart. */
async function readAvcC(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const at = buffer.subarray(0, bytesRead).indexOf("avcC");
    if (at < 4) return null;
    const size = buffer.readUInt32BE(at - 4);
    return buffer.subarray(at - 4, at - 4 + size).toString("hex");
  } finally {
    await handle.close();
  }
}

function segmentTimeoutMs(frameCount: number) {
  // Generous: 4K HDR sources tone-map at a few frames per second on a small server.
  return Math.max(3 * 60 * 1000, (frameCount / LOOP_FPS) * 30 * 1000);
}

async function encodeSegment(options: {
  segment: PlanSegment;
  sourcePath: string;
  source: MediaMetadata;
  plan: CompilePlan;
  videoPath: string;
  audioPath: string;
  tonemapAvailable: boolean;
}) {
  const { segment, sourcePath, source, plan } = options;
  const isStill = segment.kind === "still";
  const filter = videoFilter({
    size: plan.frame,
    mode: "frame",
    hdr: !isStill && isHdrTransfer(source.colorTransfer) && options.tonemapAvailable,
    fps: LOOP_FPS,
    holdLastFrame: !isStill,
  });
  await ffmpeg(
    [
      ...(isStill ? ["-loop", "1"] : []),
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-vf",
      filter,
      "-frames:v",
      String(segment.frameCount),
      ...h264Args({ keyframeIntervalFrames: KEYFRAME_INTERVAL_FRAMES }),
      "-an",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      options.videoPath,
    ],
    segmentTimeoutMs(segment.frameCount),
  );

  const samples = segment.audioSamples;
  if (!isStill && source.hasAudio) {
    // Keep the sound where it sits relative to the first frame of the picture.
    const offset = (source.audioStartSeconds ?? 0) - (source.videoStartSeconds ?? 0);
    await ffmpeg(
      ["-i", sourcePath, "-map", "0:a:0", "-af", exactAudioFilter(samples, offset), "-f", "s16le", "-acodec", "pcm_s16le", options.audioPath],
      segmentTimeoutMs(segment.frameCount),
    );
  } else {
    await ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
        "-af",
        `atrim=end_sample=${samples}`,
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        options.audioPath,
      ],
      60 * 1000,
    );
  }

  const expectedBytes = samples * AUDIO_CHANNELS * 2;
  const audioBytes = (await stat(options.audioPath)).size;
  if (audioBytes !== expectedBytes) {
    throw new CompileError(`The sound of "${segment.filename}" came out ${audioBytes} bytes instead of ${expectedBytes}.`);
  }
}

export async function probeCompiledVideo(filePath: string): Promise<CompiledProbe> {
  const [metadata, keyframes] = await Promise.all([extractMetadata(filePath), probeKeyframeTimes(filePath)]);
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    frameRate: metadata.avgFrameRate ?? metadata.frameRate ?? 0,
    videoCodec: metadata.videoCodec ?? "",
    videoProfile: metadata.videoProfile ?? null,
    pixFmt: metadata.pixFmt ?? null,
    audioCodec: metadata.audioCodec ?? null,
    audioChannels: metadata.audioChannels ?? 0,
    audioSampleRate: metadata.audioSampleRate ?? 0,
    videoFrames: keyframes.packets,
    videoDurationMs: metadata.videoDurationMs ?? 0,
    audioDurationMs: metadata.audioDurationMs ?? 0,
    containerDurationMs: metadata.durationMs ?? 0,
    keyframes: keyframes.keyframeSeconds.map((time) => Math.round(time * LOOP_FPS)),
  };
}

export type CompiledLoopVideo = {
  outputPath: string;
  fileSizeBytes: number;
  probe: CompiledProbe;
  encodeMs: number;
  segmentsEncoded: number;
  assetsFetched: number;
};

/** Compile `plan` into `workDir`/loop.mp4. Throws CompileError with a short reason on failure. */
export async function compileLoopVideo(plan: CompilePlan, workDir: string, onProgress: CompileProgress = () => undefined): Promise<CompiledLoopVideo> {
  const started = Date.now();
  const tonemapAvailable = await hasZscaleFilter();

  // 1. Fetch each distinct asset once.
  const assets = new Map<string, { s3Key: string; filename: string }>();
  for (const segment of plan.segments) assets.set(segment.assetId, { s3Key: segment.s3Key, filename: segment.filename });
  const sources = new Map<string, { path: string; metadata: MediaMetadata }>();
  let fetched = 0;
  onProgress("fetching", 0, assets.size);
  for (const [assetId, asset] of assets) {
    const extension = path.extname(asset.s3Key) || ".bin";
    const sourcePath = path.join(workDir, `src-${assetId}${extension}`);
    try {
      await downloadObjectToFile(asset.s3Key, sourcePath);
    } catch (error) {
      console.error(`could not fetch ${asset.s3Key}`, error);
      throw new CompileError(`The file for "${asset.filename}" could not be fetched from storage.`);
    }
    let metadata: MediaMetadata;
    try {
      metadata = await extractMetadata(sourcePath);
    } catch (error) {
      console.error(`could not read ${asset.s3Key}`, error);
      throw new CompileError(`"${asset.filename}" could not be read. Replace it in the loop.`);
    }
    if (!metadata.hasVideo) {
      throw new CompileError(`"${asset.filename}" has no picture. Replace it in the loop.`);
    }
    sources.set(assetId, { path: sourcePath, metadata });
    fetched += 1;
    onProgress("fetching", fetched, assets.size);
  }

  // 2. Encode each distinct segment once.
  const segmentFiles = new Map<string, { video: string; audio: string }>();
  let encoded = 0;
  onProgress("encoding", 0, plan.segments.length);
  for (const segment of plan.segments) {
    const source = sources.get(segment.assetId)!;
    const files = { video: path.join(workDir, `seg-${segment.key}.mp4`), audio: path.join(workDir, `seg-${segment.key}.pcm`) };
    try {
      await encodeSegment({ segment, sourcePath: source.path, source: source.metadata, plan, videoPath: files.video, audioPath: files.audio, tonemapAvailable });
    } catch (error) {
      if (error instanceof CompileError) throw error;
      throw new CompileError(
        `"${segment.filename}" could not be encoded: ${mediaFailureReason(error, "ffmpeg failed (details are in the server log)").replace(/\.$/, "")}.`,
      );
    }
    segmentFiles.set(segment.key, files);
    encoded += 1;
    onProgress("encoding", encoded, plan.segments.length);
  }

  // Segments are joined without re-encoding, so their H.264 headers must be identical.
  const headers = new Set<string | null>();
  for (const files of segmentFiles.values()) headers.add(await readAvcC(files.video));
  if (headers.size !== 1 || headers.has(null)) {
    throw new CompileError("The encoded segments do not share one video format, so they cannot be joined.");
  }

  // 3. Join pictures (stream copy) and sound (PCM bytes, one AAC encode), then mux.
  onProgress("assembling", 0, 1);
  const listPath = path.join(workDir, "segments.txt");
  await writeFile(
    listPath,
    plan.items.map((item) => `file '${segmentFiles.get(item.segmentKey)!.video.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  const pcmPath = path.join(workDir, "loop.pcm");
  const pcm = createWriteStream(pcmPath);
  for (const item of plan.items) {
    for await (const chunk of createReadStream(segmentFiles.get(item.segmentKey)!.audio)) {
      if (!pcm.write(chunk)) await once(pcm, "drain");
    }
  }
  await new Promise<void>((resolve, reject) => pcm.end((error?: Error | null) => (error ? reject(error) : resolve())));
  const expectedPcm = plan.totalAudioSamples * AUDIO_CHANNELS * 2;
  if ((await stat(pcmPath)).size !== expectedPcm) {
    throw new CompileError("The joined sound is not the length of the loop.");
  }

  const outputPath = path.join(workDir, "loop.mp4");
  try {
    await ffmpeg(
      [
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-f",
        "s16le",
        "-ar",
        String(AUDIO_SAMPLE_RATE),
        "-ac",
        String(AUDIO_CHANNELS),
        "-i",
        pcmPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        ...aacArgs(),
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      15 * 60 * 1000,
    );
  } catch (error) {
    throw new CompileError(`The slots could not be joined: ${mediaFailureReason(error, "ffmpeg failed (details are in the server log)")}`);
  }
  onProgress("assembling", 1, 1);

  // 4. Measure and check.
  onProgress("checking", 0, 1);
  const probe = await probeCompiledVideo(outputPath);
  const problems = verifyCompiled(plan, probe);
  if (problems.length) {
    console.error(`compiled loop does not match its plan: ${problems.join("; ")}`);
    throw new CompileError(`The compiled video does not match the loop (${problems.join("; ")}), so it was not published.`);
  }
  onProgress("checking", 1, 1);

  return {
    outputPath,
    fileSizeBytes: (await stat(outputPath)).size,
    probe,
    encodeMs: Date.now() - started,
    segmentsEncoded: plan.segments.length,
    assetsFetched: assets.size,
  };
}

