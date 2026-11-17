// One definition of how pictures and sound are normalised, used by every ffmpeg path: desktop
// asset uploads (lib/media.ts), loop compiles (lib/loop-compile.ts) and direct/phone loop uploads
// (lib/loops.ts). Pure builders of ffmpeg arguments; unit-tested in test/media-format.test.ts.
//
// - ffmpeg applies display rotation (autorotate) before the filters, so phone footage is upright.
// - Any pixel format (10-bit, 4:2:2, 4:4:4, full-range JPEG) ends as 8-bit 4:2:0 limited range,
//   tagged BT.709, with identical H.264 stream headers whatever the source (so compiled segments
//   can be joined without re-encoding).
// - HDR (HLG / PQ, e.g. iPhone default) is tone-mapped to SDR BT.709 (needs libzimg's zscale).

import { AUDIO_BITRATE, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, KEYFRAME_INTERVAL_FRAMES, VIDEO_BUFSIZE, VIDEO_CRF, VIDEO_MAXRATE, VIDEO_PRESET } from "./loop-plan";
import { LOOP_FPS } from "./slot-rules";

export type FrameSize = { width: number; height: number };

/** Library assets are kept up to this size (never padded), so a larger screen can be targeted later. */
export const ASSET_MAX_FRAME: FrameSize = { width: 1920, height: 1080 };
export const DEFAULT_LOOP_FRAME: FrameSize = { width: 1280, height: 800 };

export function isHdrTransfer(transfer: string | null | undefined) {
  return transfer === "smpte2084" || transfer === "arib-std-b67";
}

const TONEMAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0," +
  "zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
const TAGS = "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709";

/**
 * Video filter chain.
 * - mode "frame": fit inside the loop frame and pad with black to exactly that size (compiles).
 * - mode "within": shrink to fit inside `size` if larger, never enlarge, never pad (library).
 * `fps`: convert to constant frame rate (dropping/duplicating frames), or keep the source timing.
 * `holdLastFrame`: repeat the last frame indefinitely (the caller limits the frame count).
 */
export function videoFilter(options: {
  size: FrameSize;
  mode: "frame" | "within";
  hdr: boolean;
  fps?: number | null;
  holdLastFrame?: boolean;
}) {
  const { width, height } = options.size;
  const scale =
    options.mode === "frame"
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv`
      : `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv`;
  const steps = [scale, "setsar=1"];
  // Reduce the frame rate before the (expensive) tone-map.
  if (options.fps) steps.push(`fps=${options.fps}`);
  steps.push(options.hdr ? TONEMAP : "format=yuv420p");
  if (options.mode === "frame") steps.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);
  steps.push("format=yuv420p", TAGS);
  if (options.holdLastFrame) steps.push("tpad=stop_mode=clone:stop=-1");
  return steps.join(",");
}

/** H.264 High 4.1, 8-bit 4:2:0, BT.709, short keyframe interval, sensible preset. */
export function h264Args(options: { keyframeIntervalFrames?: number | null; preset?: string; crf?: number } = {}) {
  const args = [
    "-c:v",
    "libx264",
    "-preset",
    options.preset ?? VIDEO_PRESET,
    "-crf",
    String(options.crf ?? VIDEO_CRF),
    "-maxrate",
    VIDEO_MAXRATE,
    "-bufsize",
    VIDEO_BUFSIZE,
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
    "-color_range",
    "tv",
    "-chroma_sample_location",
    "left",
  ];
  if (options.keyframeIntervalFrames) {
    args.push("-g", String(options.keyframeIntervalFrames));
  }
  return args;
}

/** AAC stereo 48 kHz (downmixes 5.1, upmixes mono, resamples anything). */
export function aacArgs() {
  return ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", String(AUDIO_SAMPLE_RATE), "-ac", String(AUDIO_CHANNELS)];
}

/** Audio filter to the loop's PCM format with an exact number of samples (padding with silence). */
export function exactAudioFilter(samples: number, offsetSeconds = 0) {
  const steps: string[] = [];
  if (offsetSeconds > 0.0005) steps.push(`adelay=${Math.round(offsetSeconds * 1000)}:all=1`);
  if (offsetSeconds < -0.0005) steps.push(`atrim=start=${(-offsetSeconds).toFixed(4)}`, "asetpts=PTS-STARTPTS");
  steps.push(
    `aresample=${AUDIO_SAMPLE_RATE}`,
    `aformat=sample_fmts=s16:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`,
    "apad",
    `atrim=end_sample=${samples}`,
  );
  return steps.join(",");
}

export { KEYFRAME_INTERVAL_FRAMES, LOOP_FPS };

/**
 * A direct (pre-built) loop upload may be stored without re-encoding only if it is already
 * exactly what a compile would produce: the loop frame, H.264 8-bit 4:2:0 SDR, 30 fps constant,
 * AAC stereo 48 kHz, keyframes at most 2 s apart, no rotation.
 */
export function isAlreadyLoopFormat(
  metadata: {
    width?: number | null;
    height?: number | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
    pixFmt?: string | null;
    colorTransfer?: string | null;
    rotation?: number;
    frameRate?: number | null;
    avgFrameRate?: number | null;
    audioChannels?: number | null;
    audioSampleRate?: number | null;
    maxKeyframeIntervalMs?: number | null;
  },
  frame: FrameSize,
) {
  return (
    metadata.width === frame.width &&
    metadata.height === frame.height &&
    metadata.videoCodec === "h264" &&
    metadata.audioCodec === "aac" &&
    metadata.pixFmt === "yuv420p" &&
    !metadata.rotation &&
    !isHdrTransfer(metadata.colorTransfer) &&
    metadata.frameRate != null &&
    Math.abs(metadata.frameRate - LOOP_FPS) < 0.01 &&
    metadata.avgFrameRate != null &&
    Math.abs(metadata.avgFrameRate - LOOP_FPS) < 0.05 &&
    metadata.audioChannels === AUDIO_CHANNELS &&
    metadata.audioSampleRate === AUDIO_SAMPLE_RATE &&
    metadata.maxKeyframeIntervalMs != null &&
    metadata.maxKeyframeIntervalMs <= (KEYFRAME_INTERVAL_FRAMES * 1000) / LOOP_FPS + 1
  );
}
