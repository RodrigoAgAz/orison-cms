// The compile plan for a slot-built loop: exactly which frames and samples each item gets, which
// distinct segments must be encoded, where the keyframes go, and a key that changes only when the
// picture or sound would change. Pure (no I/O besides hashing); unit-tested in
// test/loop-plan.test.ts. lib/loop-compile.ts carries the plan out with ffmpeg.
//
// Timing model (what the cab's player assumes, device/player_manager.py): slot p starts at
// p x 60 000 ms, an item starts at slot start + its startTimeMs, the loop wraps at totalDurationMs.
// Every boundary is placed on the nearest frame at LOOP_FPS (with the builder's 0.1 s steps that
// is exact); the audio for an item is exactly as long as its picture (1600 samples per frame at
// 48 kHz), so sound never drifts from picture, and every item starts on a keyframe.

import { createHash } from "node:crypto";

import { checksumJson } from "@orison/shared/src/manifest.server";

import {
  LOOP_FPS,
  SLOT_COUNT,
  SLOT_DURATION_MS,
  fitOf,
  isStillAsset,
  publishSlotProblems,
  sortContents,
  type Fit,
  type SlotContentType,
} from "./slot-rules";

/** Bump when the encoding changes, so republishing recompiles instead of reusing the old video. */
export const COMPILER_VERSION = "orison-loop-compiler/2";
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = "128k";
export const SAMPLES_PER_FRAME = AUDIO_SAMPLE_RATE / LOOP_FPS;
/** A keyframe at least every 2 s, and one at the start of every item. */
export const KEYFRAME_INTERVAL_FRAMES = 2 * LOOP_FPS;
export const VIDEO_PRESET = "veryfast";
export const VIDEO_CRF = 23;
/** Cap the bitrate of busy pictures (cabs download over throttled 4G). */
export const VIDEO_MAXRATE = "3500k";
export const VIDEO_BUFSIZE = "7000k";

export type LoopFrame = { width: number; height: number };

export type PlanAsset = {
  id: string;
  filename: string;
  s3Key: string;
  mimeType: string;
  durationMs: number | null;
  checksum: string | null;
  fileSize: number;
};

export type PlanContent = {
  assetId: string;
  orderInSlot: number;
  startTimeMs: number;
  durationMs: number;
  contentType: SlotContentType;
  asset: PlanAsset;
};

export type PlanSlot = { position: number; contents: PlanContent[] };

export type PlanSegment = {
  key: string;
  assetId: string;
  s3Key: string;
  filename: string;
  kind: "video" | "still";
  frameCount: number;
  audioSamples: number;
  sourceDurationMs: number | null;
};

export type PlanItem = {
  slotPosition: number;
  orderInSlot: number;
  contentType: SlotContentType;
  assetId: string;
  startTimeMs: number;
  durationMs: number;
  absoluteStartMs: number;
  startFrame: number;
  frameCount: number;
  segmentKey: string;
  fit: Fit;
};

export type CompilePlan = {
  frame: LoopFrame;
  fps: number;
  slotCount: number;
  slotDurationMs: number;
  totalFrames: number;
  totalDurationMs: number;
  totalAudioSamples: number;
  items: PlanItem[];
  /** Distinct segments, in order of first use: each is fetched and encoded once. */
  segments: PlanSegment[];
  /** Frame indexes that must be keyframes (the start of every item, hence every slot). */
  requiredKeyframes: number[];
  contentKey: string;
};

export class PlanError extends Error {}

export function msToFrame(ms: number) {
  return Math.round((ms * LOOP_FPS) / 1000);
}

export function frameToMs(frame: number) {
  return (frame * 1000) / LOOP_FPS;
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function segmentKeyFor(asset: Pick<PlanAsset, "id" | "checksum" | "s3Key" | "mimeType">, frameCount: number, frame: LoopFrame) {
  const identity = asset.checksum ?? `${asset.id}:${asset.s3Key}`;
  const kind = isStillAsset(asset) ? "still" : "video";
  return sha(JSON.stringify([COMPILER_VERSION, identity, kind, frameCount, frame.width, frame.height])).slice(0, 32);
}

/** Check every slot is publishable; throws PlanError naming the first slot that is not. */
export function assertPublishable(slots: PlanSlot[]) {
  const positions = slots.map((slot) => slot.position).sort((a, b) => a - b);
  if (positions.length !== SLOT_COUNT || positions.some((position, index) => position !== index)) {
    throw new PlanError(`A loop needs exactly ${SLOT_COUNT} slots.`);
  }
  for (const slot of slots.slice().sort((a, b) => a.position - b.position)) {
    if (slot.contents.length === 0) {
      throw new PlanError(`Slot ${slot.position + 1} is empty.`);
    }
    const problems = publishSlotProblems(slot.contents);
    if (problems.length) {
      throw new PlanError(`Slot ${slot.position + 1}: ${problems[0]}`);
    }
  }
}

export function buildCompilePlan(slots: PlanSlot[], frame: LoopFrame): CompilePlan {
  assertPublishable(slots);
  const items: PlanItem[] = [];
  const segments = new Map<string, PlanSegment>();

  for (const slot of slots.slice().sort((a, b) => a.position - b.position)) {
    const slotStartMs = slot.position * SLOT_DURATION_MS;
    for (const content of sortContents(slot.contents)) {
      const absoluteStartMs = slotStartMs + content.startTimeMs;
      const startFrame = msToFrame(absoluteStartMs);
      const endFrame = msToFrame(absoluteStartMs + content.durationMs);
      const frameCount = endFrame - startFrame;
      if (frameCount < 1) {
        throw new PlanError(`Slot ${slot.position + 1}: an item is shorter than one frame.`);
      }
      const segmentKey = segmentKeyFor(content.asset, frameCount, frame);
      if (!segments.has(segmentKey)) {
        segments.set(segmentKey, {
          key: segmentKey,
          assetId: content.assetId,
          s3Key: content.asset.s3Key,
          filename: content.asset.filename,
          kind: isStillAsset(content.asset) ? "still" : "video",
          frameCount,
          audioSamples: frameCount * SAMPLES_PER_FRAME,
          sourceDurationMs: content.asset.durationMs,
        });
      }
      items.push({
        slotPosition: slot.position,
        orderInSlot: content.orderInSlot,
        contentType: content.contentType,
        assetId: content.assetId,
        startTimeMs: content.startTimeMs,
        durationMs: content.durationMs,
        absoluteStartMs,
        startFrame,
        frameCount,
        segmentKey,
        fit: fitOf(content.asset, content.durationMs),
      });
    }
  }

  const totalDurationMs = SLOT_COUNT * SLOT_DURATION_MS;
  const totalFrames = msToFrame(totalDurationMs);
  // Items are contiguous (validated), so frames add up; check anyway.
  const covered = items.reduce((sum, item) => sum + item.frameCount, 0);
  if (covered !== totalFrames) {
    throw new PlanError(`The slots cover ${covered} frames instead of ${totalFrames}.`);
  }

  const contentKey = `sha256:${sha(
    JSON.stringify({
      v: COMPILER_VERSION,
      frame,
      fps: LOOP_FPS,
      audio: [AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITRATE],
      video: [VIDEO_PRESET, VIDEO_CRF, KEYFRAME_INTERVAL_FRAMES, VIDEO_MAXRATE],
      items: items.map((item) => item.segmentKey),
    }),
  )}`;

  return {
    frame,
    fps: LOOP_FPS,
    slotCount: SLOT_COUNT,
    slotDurationMs: SLOT_DURATION_MS,
    totalFrames,
    totalDurationMs,
    totalAudioSamples: totalFrames * SAMPLES_PER_FRAME,
    items,
    segments: [...segments.values()],
    requiredKeyframes: [...new Set(items.map((item) => item.startFrame))].sort((a, b) => a - b),
    contentKey,
  };
}

/** What ffprobe measured on a compiled file (see loop-compile.ts probeCompiledVideo). */
export type CompiledProbe = {
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  videoProfile: string | null;
  pixFmt: string | null;
  audioCodec: string | null;
  audioChannels: number;
  audioSampleRate: number;
  videoFrames: number;
  videoDurationMs: number;
  audioDurationMs: number;
  containerDurationMs: number;
  keyframes: number[];
};

/**
 * Compare the compiled file with its plan. Returns plain-words problems; a publish with any is
 * refused. Durations must match within one frame, every item must start on a keyframe.
 */
export function verifyCompiled(plan: CompilePlan, probe: CompiledProbe) {
  const problems: string[] = [];
  const frameMs = 1000 / plan.fps;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
  if (probe.width !== plan.frame.width || probe.height !== plan.frame.height) {
    problems.push(`the picture is ${probe.width}x${probe.height}, not ${plan.frame.width}x${plan.frame.height}`);
  }
  if (Math.abs(probe.frameRate - plan.fps) > 0.01) problems.push(`it runs at ${probe.frameRate} fps, not ${plan.fps}`);
  if (probe.videoFrames !== plan.totalFrames) problems.push(`it has ${probe.videoFrames} frames, not ${plan.totalFrames}`);
  for (const [label, value] of [
    ["picture", probe.videoDurationMs],
    ["sound", probe.audioDurationMs],
    ["file", probe.containerDurationMs],
  ] as const) {
    if (Math.abs(value - plan.totalDurationMs) > frameMs) {
      problems.push(`the ${label} lasts ${seconds(value)}, not ${seconds(plan.totalDurationMs)}`);
    }
  }
  if (probe.audioCodec !== "aac" || probe.audioChannels !== AUDIO_CHANNELS || probe.audioSampleRate !== AUDIO_SAMPLE_RATE) {
    problems.push(`the sound is ${probe.audioCodec ?? "missing"} ${probe.audioChannels} ch ${probe.audioSampleRate} Hz, not AAC stereo 48 kHz`);
  }
  const keyframes = new Set(probe.keyframes);
  const missing = plan.requiredKeyframes.filter((frame) => !keyframes.has(frame));
  if (missing.length) {
    problems.push(`${missing.length} item${missing.length === 1 ? " does" : "s do"} not start on a keyframe (first at ${seconds(frameToMs(missing[0]))})`);
  }
  const sorted = probe.keyframes.slice().sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] > KEYFRAME_INTERVAL_FRAMES) {
      problems.push(`keyframes are ${(sorted[index] - sorted[index - 1]) / plan.fps} s apart at ${seconds(frameToMs(sorted[index - 1]))}`);
      break;
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Manifest

export type ManifestStill = { assetId: string | null; url: string; checksum: string; fileSizeBytes: number };

export type ManifestInput = {
  loop: { id: string; name: string; targetGroupId: string | null };
  plan: CompilePlan;
  slots: Array<{
    position: number;
    staticCreative: (ManifestStill & { assetId: string }) | null;
    contents: PlanContent[];
  }>;
  assetUrl: (key: string) => string;
  fallbackStill: ManifestStill;
  safetyVideo: { url: string; checksum: string; durationMs: number; mimeType: string; fileSizeBytes: number } | null;
  video: {
    url: string;
    checksum: string;
    fileSizeBytes: number;
    probe: CompiledProbe;
  };
  publishedAt: Date;
};

/**
 * The manifest a cab downloads for a slot-built loop. Everything the old firmware reads keeps its
 * meaning (slots[].position, contents[].startTimeMs/durationMs/type/assetId, totalDurationMs,
 * compiledVideoUrl/Checksum, safetyVideo, static images). Additive fields describe the compiled
 * file fully, so a player need not assume ten one-minute slots:
 *   formatVersion, slotCount, slotDurationMs, slots[].startMs/durationMs,
 *   contents[].absoluteStartMs/sourceDurationMs/fit, video{...}.
 * totalDurationMs is measured from the compiled file (verified to match the plan within a frame).
 */
export function buildSlotLoopManifest(input: ManifestInput) {
  const { plan, video } = input;
  const itemsBySlot = new Map<number, PlanItem[]>();
  for (const item of plan.items) {
    const list = itemsBySlot.get(item.slotPosition) ?? [];
    list.push(item);
    itemsBySlot.set(item.slotPosition, list);
  }
  const distinctStills = new Map<string, number>();

  const slots = input.slots
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((slot) => {
      const still = slot.staticCreative ?? input.fallbackStill;
      distinctStills.set(still.url, still.fileSizeBytes);
      const contents = sortContents(slot.contents);
      const advertisement = contents.find((content) => content.contentType === "ADVERTISEMENT");
      const planItems = itemsBySlot.get(slot.position) ?? [];
      return {
        position: slot.position,
        startMs: slot.position * plan.slotDurationMs,
        durationMs: plan.slotDurationMs,
        staticImageAssetId: slot.staticCreative?.assetId ?? null,
        staticImageUrl: still.url,
        staticImageChecksum: still.checksum,
        advertisementVideoUrl: advertisement ? input.assetUrl(advertisement.asset.s3Key) : null,
        contents: contents.map((content, index) => {
          const item = planItems[index];
          return {
            type: content.contentType,
            assetId: content.assetId,
            filename: content.asset.filename,
            url: input.assetUrl(content.asset.s3Key),
            checksum: content.asset.checksum ?? "",
            startTimeMs: content.startTimeMs,
            durationMs: content.durationMs,
            absoluteStartMs: item?.absoluteStartMs ?? slot.position * plan.slotDurationMs + content.startTimeMs,
            sourceDurationMs: content.asset.mimeType.startsWith("image/") ? null : content.asset.durationMs,
            fit: item?.fit.kind ?? "unknown",
            fileSizeBytes: content.asset.fileSize,
          };
        }),
      };
    });

  const stillBytes = [...distinctStills.values()].reduce((sum, size) => sum + size, 0);
  const body = {
    version: "1.0",
    formatVersion: 2,
    loopId: input.loop.id,
    loopName: input.loop.name,
    targetGroupId: input.loop.targetGroupId ?? null,
    publishedAt: input.publishedAt.toISOString(),
    totalDurationMs: Math.round(video.probe.videoDurationMs),
    slotCount: plan.slotCount,
    slotDurationMs: plan.slotDurationMs,
    video: {
      width: video.probe.width,
      height: video.probe.height,
      frameRate: plan.fps,
      frameCount: video.probe.videoFrames,
      codec: video.probe.videoCodec,
      profile: video.probe.videoProfile,
      pixelFormat: video.probe.pixFmt,
      audioCodec: video.probe.audioCodec,
      audioChannels: video.probe.audioChannels,
      audioSampleRate: video.probe.audioSampleRate,
      videoDurationMs: video.probe.videoDurationMs,
      audioDurationMs: video.probe.audioDurationMs,
      keyframeIntervalMs: frameToMs(KEYFRAME_INTERVAL_FRAMES),
      keyframeAtEveryItemStart: true,
      fileSizeBytes: video.fileSizeBytes,
      compiler: COMPILER_VERSION,
    },
    safetyVideo: input.safetyVideo
      ? {
          url: input.safetyVideo.url,
          checksum: input.safetyVideo.checksum,
          durationMs: input.safetyVideo.durationMs,
          mimeType: input.safetyVideo.mimeType,
        }
      : undefined,
    slots,
    // What the cab downloads: the compiled video, each distinct still, and the safety message.
    totalDownloadSizeBytes: video.fileSizeBytes + stillBytes + (input.safetyVideo?.fileSizeBytes ?? 0),
    compiledVideoUrl: video.url,
    compiledVideoChecksum: video.checksum,
  };
  return finishManifest(body);
}

/** Add the checksum, and the key that ignores publishedAt (same content = same key). */
export function finishManifest<T extends { publishedAt: string }>(body: T) {
  const { publishedAt: _publishedAt, ...content } = body;
  const manifestContentKey = checksumJson(content);
  const checksum = checksumJson(body);
  return { manifest: { ...body, checksum }, checksum, manifestContentKey };
}

/**
 * A key for the slots exactly as saved (whatever state they are in) plus the loop frame: equal
 * keys mean nothing that reaches a cab's screen has changed. Stored at publish
 * (Loop.publishedDraftKey) to show "changes not yet published".
 */
export function draftKeyOf(
  slots: Array<{
    position: number;
    staticCreativeId: string | null;
    contents: Array<{ assetId: string; startTimeMs: number; durationMs: number; contentType: string; orderInSlot: number; asset?: { checksum: string | null } | null }>;
  }>,
  frame: LoopFrame,
) {
  const body = slots
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((slot) => [
      slot.position,
      slot.staticCreativeId,
      sortContents(slot.contents).map((content) => [content.assetId, content.asset?.checksum ?? null, content.startTimeMs, content.durationMs, content.contentType]),
    ]);
  return `sha256:${sha(JSON.stringify([COMPILER_VERSION, frame.width, frame.height, body]))}`;
}

/** Whether the saved slots differ from what is on air (legacy loops: edited after publishing). */
export function hasUnpublishedChanges(loop: {
  publishedAt: Date | null;
  publishedDraftKey: string | null;
  currentDraftKey: string;
  lastSlotEditAt: Date | null;
}) {
  if (!loop.publishedAt) return false;
  if (loop.publishedDraftKey) return loop.publishedDraftKey !== loop.currentDraftKey;
  return Boolean(loop.lastSlotEditAt && loop.lastSlotEditAt.getTime() > loop.publishedAt.getTime());
}
