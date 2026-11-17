import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { prisma, type Loop, type LoopStatus, type Prisma } from "@orison/db";
import { directLoopUploadMaxBytes, directLoopUploadMaxDurationMs, type SlotContentInput } from "@orison/shared";

import { logActivity } from "./activity";
import { assignLoop, assignTargetSchema, describeTarget } from "./assignment";
import { getCmsSettings, loopFrameFrom } from "./cms-settings";
import { createKeyedJobs, createLimiter, mediaJobLimiter, processSingleton } from "./job-limits";
import { generateContactSheet } from "./loop-poster";
import { contactSheetTimes } from "./loop-publish";
import { getLoopRoutingSnapshot } from "./loop-routing";
import { finishManifest, KEYFRAME_INTERVAL_FRAMES } from "./loop-plan";
import { commandExists, extractMetadata, maxGapMs, probeKeyframeTimes } from "./media";
import { aacArgs, h264Args, isAlreadyLoopFormat, isHdrTransfer, videoFilter, type FrameSize } from "./media-format";
import { hasZscaleFilter } from "./media";
import { draftSlotProblems, LOOP_FPS, SLOT_COUNT, SLOT_DURATION_MS } from "./slot-rules";
import {
  deleteObject,
  downloadObjectToFile,
  getObjectReadLocation,
  getPublicUrl,
  putObject,
  putObjectFromFile,
  readObject,
} from "./storage";
import { enqueueUploadJob } from "./upload-queue";
import {
  afterConditionalPublish,
  shouldApplyUploadTarget,
  staleTargetMessage,
  targetLastChangedAt,
} from "./upload-rules";

const execFileAsync = promisify(execFile);

type SafetyVideoManifestData = {
  url: string;
  checksum: string;
  durationMs: number;
  fileSizeBytes: number;
  mimeType: string;
};

/** A save based on data that someone else has changed since it was loaded. */
export class StaleEditError extends Error {}
/** A request that breaks a rule, with a message fit for staff. */
export class LoopRuleError extends Error {}

export async function createLoopDraft(name: string) {
  const loop = await prisma.$transaction(async (tx) => {
    const created = await tx.loop.create({ data: { name, status: "DRAFT" } });
    await tx.slot.createMany({
      data: Array.from({ length: SLOT_COUNT }, (_, position) => ({ loopId: created.id, position })),
    });
    return tx.loop.findUniqueOrThrow({
      where: { id: created.id },
      include: { slots: { orderBy: { position: "asc" } } },
    });
  });
  await logActivity("LOOP_CREATED", `Loop ${name} created`, { loopId: loop.id, name });
  return loop;
}

/** A name for a copy that no other loop has: "X (copy)", "X (copy 2)", ... */
export function copyName(name: string, taken: Set<string>) {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, "");
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? `${base} (copy)` : `${base} (copy ${index})`;
    if (!taken.has(candidate)) return candidate.slice(0, 120);
  }
}

/** Copy a slot-built loop's slots, still images and target into a new draft. */
export async function duplicateLoop(loopId: string) {
  const existing = await prisma.loop.findUnique({
    where: { id: loopId },
    include: { slots: { orderBy: { position: "asc" }, include: { contents: { orderBy: { orderInSlot: "asc" } } } } },
  });
  if (!existing) {
    throw new LoopRuleError("Loop not found");
  }
  if (existing.slots.length === 0) {
    throw new LoopRuleError("A pre-built (uploaded) loop cannot be duplicated: upload its file again instead.");
  }
  const similar = await prisma.loop.findMany({
    where: { name: { startsWith: existing.name.replace(/ \(copy(?: \d+)?\)$/, "") } },
    select: { name: true },
  });
  const name = copyName(existing.name, new Set(similar.map((loop) => loop.name)));

  const duplicated = await prisma.$transaction(async (tx) => {
    const loop = await tx.loop.create({ data: { name, status: "DRAFT", targetGroupId: existing.targetGroupId } });
    for (const slot of existing.slots) {
      const newSlot = await tx.slot.create({
        data: { loopId: loop.id, position: slot.position, staticCreativeId: slot.staticCreativeId },
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
    return loop;
  });
  await logActivity("LOOP_CREATED", `Loop ${name} created as a copy of ${existing.name}`, {
    loopId: duplicated.id,
    copiedFrom: existing.id,
  });
  return duplicated;
}

export async function loadLoop(loopId: string) {
  return prisma.loop.findUnique({
    where: { id: loopId },
    include: {
      slots: {
        orderBy: { position: "asc" },
        include: {
          staticCreative: true,
          contents: { orderBy: { orderInSlot: "asc" }, include: { asset: true } },
        },
      },
    },
  });
}

export type SlotSave = {
  position: number;
  contents: SlotContentInput[];
  staticCreativeId?: string | null;
  /** The slot's updatedAt the editor loaded; a save is refused if the slot changed since. */
  expectedUpdatedAt?: string | null;
};

/**
 * Save several slots of a loop in one transaction. Refused as a whole if any slot breaks a draft
 * rule (LoopRuleError) or was changed by someone else since it was loaded (StaleEditError).
 */
export async function saveSlots(loopId: string, saves: SlotSave[]) {
  for (const save of saves) {
    const problems = draftSlotProblems(save.contents);
    if (problems.length) {
      throw new LoopRuleError(`Slot ${save.position + 1}: ${problems[0]}`);
    }
  }
  const assetIds = [...new Set(saves.flatMap((save) => save.contents.map((content) => content.assetId)))];
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, status: true, filename: true } });
  const ready = new Set(assets.filter((asset) => asset.status === "READY").map((asset) => asset.id));
  const missing = assetIds.find((id) => !ready.has(id));
  if (missing) {
    const asset = assets.find((entry) => entry.id === missing);
    throw new LoopRuleError(asset ? `"${asset.filename}" is not ready to use.` : "One of the chosen files no longer exists.");
  }
  const stillIds = [...new Set(saves.map((save) => save.staticCreativeId).filter((id): id is string => Boolean(id)))];
  if (stillIds.length) {
    const stills = await prisma.asset.findMany({ where: { id: { in: stillIds } } });
    for (const id of stillIds) {
      const still = stills.find((asset) => asset.id === id);
      if (!still || still.status !== "READY" || still.category !== "STATIC_CREATIVE") {
        throw new LoopRuleError("The still image must be a ready file from the Still images category.");
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const save of saves) {
      const slot = await tx.slot.findUnique({ where: { loopId_position: { loopId, position: save.position } } });
      if (!slot) {
        throw new LoopRuleError(`Slot ${save.position + 1} not found`);
      }
      if (save.expectedUpdatedAt && slot.updatedAt.toISOString() !== save.expectedUpdatedAt) {
        throw new StaleEditError(
          `Slot ${save.position + 1} was changed by someone else after you opened this loop. Reload to see their version, then make your change again.`,
        );
      }
      await tx.slot.update({ where: { id: slot.id }, data: { staticCreativeId: save.staticCreativeId ?? null } });
      await tx.slotContent.deleteMany({ where: { slotId: slot.id } });
      await tx.slotContent.createMany({
        data: save.contents.map((content) => ({
          slotId: slot.id,
          assetId: content.assetId,
          orderInSlot: content.orderInSlot,
          startTimeMs: content.startTimeMs,
          durationMs: content.durationMs,
          contentType: content.contentType,
        })),
      });
    }
  });

  return loadLoop(loopId);
}

/** Save one slot (kept for the per-slot route). */
export async function updateSlotContents(
  loopId: string,
  position: number,
  contents: SlotContentInput[],
  staticCreativeId?: string | null,
  expectedUpdatedAt?: string | null,
) {
  return saveSlots(loopId, [{ position, contents, staticCreativeId, expectedUpdatedAt }]);
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

async function runFfmpeg(args: string[], options: { timeoutMs?: number } = {}) {
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    timeout: options.timeoutMs ?? 30 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Normalise an uploaded pre-built loop to the loop format (the same one a slot-built loop is
 * compiled to, lib/media-format.ts): the loop frame from Settings (fitted, never stretched),
 * H.264 High 4.1 8-bit 4:2:0 SDR (HDR tone-mapped), 30 fps constant, a keyframe every 2 s,
 * AAC stereo 48 kHz (silence added when the source has none), faststart.
 */
async function transcodeCompiledLoopVideo(
  inputPath: string,
  outputPath: string,
  metadata: Awaited<ReturnType<typeof extractMetadata>>,
  frame: FrameSize,
) {
  const hdr = isHdrTransfer(metadata.colorTransfer) && (await hasZscaleFilter());
  await runFfmpeg([
    "-i",
    inputPath,
    ...(metadata.hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
    "-map",
    "0:v:0",
    "-map",
    metadata.hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    videoFilter({ size: frame, mode: "frame", hdr, fps: LOOP_FPS }),
    ...h264Args({ keyframeIntervalFrames: KEYFRAME_INTERVAL_FRAMES }),
    ...aacArgs(),
    ...(metadata.hasAudio ? [] : ["-shortest"]),
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function remuxCompiledLoopVideo(inputPath: string, outputPath: string) {
  await runFfmpeg(["-i", inputPath, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart", outputPath]);
}

async function isDirectLoopAlreadyStandard(filePath: string, metadata: Awaited<ReturnType<typeof extractMetadata>>, frame: FrameSize) {
  const cheap = isAlreadyLoopFormat({ ...metadata, maxKeyframeIntervalMs: 0 }, frame);
  if (!cheap) return false;
  const { keyframeSeconds } = await probeKeyframeTimes(filePath);
  return isAlreadyLoopFormat({ ...metadata, maxKeyframeIntervalMs: maxGapMs(keyframeSeconds, metadata.durationMs ?? 0) }, frame);
}

async function checksumFilePath(filePath: string) {
  const digest = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }

  return `sha256:${digest.digest("hex")}`;
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
  const frame = loopFrameFrom(await getCmsSettings());
  try {
    if (await isDirectLoopAlreadyStandard(tempFilePath, sourceMetadata, frame)) {
      await remuxCompiledLoopVideo(tempFilePath, outputPath);
    } else {
      await transcodeCompiledLoopVideo(tempFilePath, outputPath, sourceMetadata, frame);
    }
  } catch (error) {
    console.error("loop transcode failed", error);
    throw new LoopUploadError("The video could not be converted. Try exporting it again as MP4 or MOV.");
  }

  const outputMetadata = await extractMetadata(outputPath);
  // The picture's length: what the cab's player loops at (totalDurationMs).
  const durationMs = outputMetadata.videoDurationMs ?? outputMetadata.durationMs ?? sourceMetadata.durationMs;
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
  const isUrl = /^https?:\/\//.test(videoPath);
  await runFfmpeg([
    // Over HTTP(S) ffmpeg reads the header and seeks with range requests, so only a few MB of a
    // faststart MP4 are fetched. Give up on a stalled connection instead of hanging.
    ...(isUrl ? ["-rw_timeout", "30000000"] : []),
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
  ], { timeoutMs: 2 * 60 * 1000 });
}

/**
 * Upload the compiled video, manifest and poster for an existing Loop row and mark it PUBLISHED,
 * but only if the row is still in `requireStatus` (checked atomically in the same UPDATE). A phone
 * upload that was removed (archived) or marked failed while it was being prepared is therefore
 * never published, and the caller must not apply its target. Returns null in that case.
 * Cleans up uploaded objects if anything fails or the publish is refused.
 */
async function publishPreparedLoopVideo(options: {
  loop: Loop;
  prepared: PreparedLoopVideo;
  workDir: string;
  publishedByUserId: string;
  requireStatus: LoopStatus;
  /** Status once stored (default PUBLISHED). DRAFT keeps a desktop upload off air until published. */
  finalStatus?: "PUBLISHED" | "DRAFT";
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
    const outputMetadata = await extractMetadata(prepared.outputPath);
    const body = {
      version: "1.0",
      formatVersion: 2,
      loopId: loop.id,
      loopName: loop.name,
      targetGroupId: loop.targetGroupId ?? null,
      publishedAt: publishedAt.toISOString(),
      totalDurationMs: prepared.durationMs,
      // A pre-built loop has no slots: the player has no schedule to follow inside it.
      slotCount: 0,
      slotDurationMs: null,
      video: {
        width: outputMetadata.width ?? null,
        height: outputMetadata.height ?? null,
        frameRate: outputMetadata.avgFrameRate ?? null,
        codec: outputMetadata.videoCodec ?? null,
        profile: outputMetadata.videoProfile ?? null,
        pixelFormat: outputMetadata.pixFmt ?? null,
        audioCodec: outputMetadata.audioCodec ?? null,
        audioChannels: outputMetadata.audioChannels ?? null,
        audioSampleRate: outputMetadata.audioSampleRate ?? null,
        videoDurationMs: outputMetadata.videoDurationMs ?? null,
        audioDurationMs: outputMetadata.audioDurationMs ?? null,
        keyframeIntervalMs: (KEYFRAME_INTERVAL_FRAMES * 1000) / LOOP_FPS,
        fileSizeBytes: prepared.fileSizeBytes,
      },
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
    const { manifest: manifestWithChecksum, checksum, manifestContentKey } = finishManifest(body);

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

    const updated = await prisma.loop.updateMany({
      where: { id: loop.id, status: options.requireStatus },
      data: {
        status: options.finalStatus ?? "PUBLISHED",
        publishedAt,
        publishedBy: publishedByUserId,
        publishError: null,
        manifestContentKey,
        manifestKey,
        manifestUrl: getPublicUrl(manifestKey),
        compiledVideoKey,
        compiledVideoUrl,
        checksum,
        durationMs: prepared.durationMs,
        posterKey: storedPosterKey,
      },
    });
    if (updated.count === 0) {
      // Removed or given up on while it was being prepared: discard what was stored.
      await deleteObject(manifestKey).catch(() => undefined);
      await deleteObject(compiledVideoKey).catch(() => undefined);
      await deleteObject(posterKey).catch(() => undefined);
      return null;
    }

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

/** Where a pre-built loop uploaded from the desktop plays once it is ready. */
export type DesktopUploadTarget = { kind: "library" } | { kind: "all" } | { kind: "group"; groupId: string };

/**
 * Create the Loop row for a pre-built loop uploaded from the desktop (PUBLISHING, autoLive: it
 * behaves like any desktop loop, with its target group) before it is processed in the background.
 */
export async function createPendingDesktopLoop(options: { name: string; target: DesktopUploadTarget }) {
  return prisma.loop.create({
    data: {
      name: options.name,
      status: "PUBLISHING",
      autoLive: true,
      targetGroupId: options.target.kind === "group" ? options.target.groupId : null,
    },
  });
}

export { STALE_PUBLISHING_MESSAGE, STALE_PUBLISHING_MS } from "./upload-rules";

/** Create the Loop row for a phone upload (PUBLISHING, autoLive false) before processing. */
export async function createPendingUploadLoop(options: {
  name: string;
  pendingTarget: Prisma.InputJsonValue | null;
  /** When the upload was requested; a change to the same target after this wins over the upload. */
  requestedAt?: Date;
}) {
  return prisma.loop.create({
    data: {
      name: options.name,
      status: "PUBLISHING",
      autoLive: false,
      pendingTarget: options.pendingTarget ?? undefined,
      pendingTargetAt: options.pendingTarget ? options.requestedAt ?? new Date() : null,
    },
  });
}

// The phone app's actor: a signed-in user, or the shared "not signed in" identity with the
// request address (lib/auth.ts requirePhoneAppActor).
type UploadUser = { id: string; name: string; anonymous?: boolean; ip?: string | null; forwardedFor?: string | null };

/**
 * Apply the target chosen at upload time, unless someone changed that target after the upload was
 * requested (then their newer choice stays and the video is just left in the library). Always
 * clears `pendingTargetAt`, and records a plain-words note in `publishError` when the target was
 * not applied.
 */
async function applyUploadTarget(loopId: string, user: UploadUser) {
  const loop = await prisma.loop.findUniqueOrThrow({
    where: { id: loopId },
    select: { id: true, name: true, pendingTarget: true, pendingTargetAt: true },
  });
  const requestedAt = loop.pendingTargetAt;
  const parsed = assignTargetSchema.safeParse(loop.pendingTarget);
  if (!requestedAt || !parsed.success) {
    await prisma.loop.update({ where: { id: loop.id }, data: { pendingTargetAt: null } });
    return;
  }
  const target = parsed.data;
  let note: string | null = null;
  try {
    const [{ label }, snapshot, cab] = await Promise.all([
      describeTarget(target),
      getLoopRoutingSnapshot(),
      target.type === "cab"
        ? prisma.device.findUnique({ where: { id: target.deviceId }, select: { overrideAt: true } })
        : Promise.resolve(null),
    ]);
    const lastChangedAt = targetLastChangedAt(target, snapshot, cab);
    if (shouldApplyUploadTarget(lastChangedAt, requestedAt)) {
      await assignLoop({ loopId: loop.id, target }, user);
    } else {
      note = staleTargetMessage(label);
      await logActivity("LOOP_ASSIGNMENT_SKIPPED", `"${loop.name}" was not put on ${label}: it was changed while the video was uploading`, {
        loopId: loop.id,
        target,
        requestedAt: requestedAt.toISOString(),
        changedAt: lastChangedAt?.toISOString() ?? null,
      });
    }
  } catch (error) {
    console.error(`could not apply the upload target for loop ${loop.id}`, error);
    note = `It was saved to your videos, but couldn't be put on screens: ${
      error instanceof Error ? error.message : "unknown error"
    }. Choose where it plays from here.`;
  }
  await prisma.loop.update({
    where: { id: loop.id },
    data: { pendingTargetAt: null, ...(note ? { publishError: note } : {}) },
  });
}

/**
 * Run the upload pipeline for a pre-created Loop row. Never throws: failures are written to
 * `publishError` (status DRAFT). The temp directory is always removed. Publishing only succeeds
 * while the row is still PUBLISHING; then the requested target (if any) is applied.
 */
export async function processUploadedLoop(options: {
  loopId: string;
  originalFilename: string;
  tempFilePath: string;
  tempDir: string;
  publishedBy: UploadUser;
  /** Phone (default): published, then put where the phone asked. Desktop: see DesktopUploadTarget. */
  desktop?: { target: DesktopUploadTarget };
}) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-mobile-loop-")).catch(() => null);
  try {
    if (!workDir) {
      throw new Error("Could not create a working directory");
    }
    const loop = await prisma.loop.findUnique({ where: { id: options.loopId } });
    if (!loop || loop.status !== "PUBLISHING") {
      return; // removed before it was prepared
    }
    const prepared = await prepareLoopVideo(options.tempFilePath, workDir);
    let finalStatus: "PUBLISHED" | "DRAFT" = "PUBLISHED";
    let note: string | null = null;
    const desktopTarget = options.desktop?.target;
    if (desktopTarget) {
      finalStatus = desktopTarget.kind === "library" ? "DRAFT" : "PUBLISHED";
      if (desktopTarget.kind === "group") {
        // The group may have been deleted while this was converted: then it would play on all cabs.
        const current = await prisma.loop.findUnique({ where: { id: loop.id }, select: { targetGroupId: true } });
        if (current?.targetGroupId !== desktopTarget.groupId) {
          finalStatus = "DRAFT";
          note = "Its group was deleted while the video was being converted, so it was kept off air. Choose where it plays and put it on air.";
        }
      }
    }
    const where = desktopTarget?.kind === "group" ? "its group" : "all cabs";
    const published = await publishPreparedLoopVideo({
      loop,
      prepared,
      workDir,
      publishedByUserId: options.publishedBy.id,
      requireStatus: "PUBLISHING",
      finalStatus,
      activity: {
        message: desktopTarget
          ? `Loop ${loop.name} uploaded by ${options.publishedBy.name}${finalStatus === "PUBLISHED" ? ` and put on air for ${where}` : ", kept off air"}`
          : `Loop ${loop.name} uploaded from the phone app by ${options.publishedBy.name}`,
        metadata: {
          originalFilename: options.originalFilename,
          mode: desktopTarget ? "DIRECT_UPLOAD" : "MOBILE_UPLOAD",
          userId: options.publishedBy.id,
          userName: options.publishedBy.name,
          ...(options.publishedBy.anonymous
            ? { anonymous: true, ip: options.publishedBy.ip ?? null, forwardedFor: options.publishedBy.forwardedFor ?? null }
            : {}),
        },
      },
    });
    const next = afterConditionalPublish({
      publishedRows: published ? 1 : 0,
      hasPendingTarget: Boolean(loop.pendingTarget && loop.pendingTargetAt),
    });
    if (next === "discard") {
      await logActivity("LOOP_UPLOAD_DISCARDED", `Upload of "${loop.name}" finished after it was removed, so it was discarded`, {
        loopId: loop.id,
      }).catch(() => undefined);
      return;
    }
    if (note) {
      await prisma.loop.update({ where: { id: loop.id }, data: { publishError: note } });
    }
    if (next === "apply-target") {
      await applyUploadTarget(loop.id, options.publishedBy);
    }
  } catch (error) {
    const message =
      error instanceof LoopUploadError
        ? error.message
        : "Processing failed unexpectedly. Please try again or use a different file.";
    if (!(error instanceof LoopUploadError)) {
      console.error(`loop upload ${options.loopId} failed`, error);
    }
    // Only a row that is still being processed is marked failed (never one that was removed).
    await prisma.loop
      .updateMany({
        where: { id: options.loopId, status: "PUBLISHING" },
        data: { status: "DRAFT", publishError: message, pendingTargetAt: null },
      })
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

/**
 * Queue an upload for processing (long-lived Node server). Uploads (phone and desktop) are
 * prepared one at a time; later ones wait and are reported as waiting.
 */
export function startUploadedLoopProcessing(options: Parameters<typeof processUploadedLoop>[0]) {
  void enqueueUploadJob(options.loopId, () => processUploadedLoop(options)).catch((error) =>
    console.error("unhandled upload pipeline error", error),
  );
}

// At most two posters are generated at once, and only one job per loop: after a deploy every
// existing loop lacks a poster and the first open of the app asks for all of them together.
const posterJobs = processSingleton("poster-jobs", () => createKeyedJobs<string | null>(createLimiter(2)));

/**
 * Lazily create (and cache in storage) a poster JPEG for a loop with a compiled video.
 * Returns the storage key, or null if the loop has no video.
 */
export async function ensureLoopPoster(loopId: string): Promise<string | null> {
  const loop = await prisma.loop.findUnique({
    where: { id: loopId },
    select: { posterKey: true, compiledVideoKey: true },
  });
  if (!loop?.compiledVideoKey) {
    return null;
  }
  if (loop.posterKey) {
    return loop.posterKey;
  }
  return posterJobs.run(loopId, () => generateLoopPoster(loopId));
}

async function generateLoopPoster(loopId: string): Promise<string | null> {
  // Re-read: the poster may have been made while this job waited for a slot.
  const loop = await prisma.loop.findUnique({
    where: { id: loopId },
    select: { id: true, posterKey: true, compiledVideoKey: true, durationMs: true, manifestKey: true },
  });
  if (!loop?.compiledVideoKey) {
    return null;
  }
  if (loop.posterKey) {
    return loop.posterKey;
  }
  const videoKey = loop.compiledVideoKey;

  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-poster-"));
  try {
    const posterPath = path.join(workDir, "poster.jpg");
    let durationMs = loop.durationMs;
    const sheet = await contactSheetPlan(loop.manifestKey);
    const make = async (videoPath: string) => {
      if (sheet) {
        await generateContactSheet(videoPath, sheet.times, posterPath, sheet.frame);
      } else {
        durationMs ??= (await extractMetadata(videoPath)).durationMs ?? null;
        await generatePosterImage(videoPath, posterPath, durationMs);
      }
    };
    const source = await getObjectReadLocation(videoKey);
    let made = false;
    if (source.kind === "url") {
      // Object storage: ffmpeg reads only what it needs over a signed URL (range requests)
      // instead of the whole 100-300MB file.
      try {
        await make(source.location);
        made = true;
      } catch (error) {
        console.warn(`poster from signed URL failed for loop ${loop.id}; downloading instead`, error);
      }
    }
    if (!made) {
      let videoPath = source.location;
      if (source.kind === "url") {
        videoPath = path.join(workDir, "loop.mp4");
        await downloadObjectToFile(videoKey, videoPath); // streamed to disk, never buffered
      }
      await make(videoPath);
    }
    const posterKey = `loops/${loop.id}/${Date.now()}-${randomUUID()}-poster.jpg`;
    await putObjectFromFile({ key: posterKey, filePath: posterPath, contentType: "image/jpeg" });
    // Only attach it if the loop still has the same video (it may have been republished).
    const updated = await prisma.loop.updateMany({
      where: { id: loop.id, compiledVideoKey: videoKey },
      data: { posterKey, ...(loop.durationMs ? {} : durationMs ? { durationMs } : {}) },
    });
    if (updated.count === 0) {
      await deleteObject(posterKey).catch(() => undefined);
      return (await prisma.loop.findUnique({ where: { id: loop.id }, select: { posterKey: true } }))?.posterKey ?? null;
    }
    return posterKey;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * For a slot-built loop, where to take the contact sheet's frames from: its published manifest
 * (what is really in the compiled video). Null for a pre-built loop or an unreadable manifest.
 */
async function contactSheetPlan(manifestKey: string | null) {
  if (!manifestKey) return null;
  try {
    const manifest = JSON.parse((await readObject(manifestKey)).toString("utf8")) as {
      slots?: Array<{ position: number; contents?: Array<{ type: string; assetId: string; startTimeMs: number; durationMs: number }> }>;
      slotDurationMs?: number | null;
      video?: { width?: number; height?: number };
    };
    const slots = (manifest.slots ?? []).map((slot) => ({
      position: slot.position,
      contents: (slot.contents ?? []).map((content) => ({ ...content, contentType: content.type })),
    }));
    const times = contactSheetTimes(slots, manifest.slotDurationMs ?? SLOT_DURATION_MS);
    if (times.length === 0) return null;
    const settingsFrame = loopFrameFrom(await getCmsSettings());
    const frame =
      manifest.video?.width && manifest.video?.height
        ? { width: manifest.video.width, height: manifest.video.height }
        : manifest.video
          ? settingsFrame
          : { width: 1280, height: 800 };
    return { times, frame };
  } catch (error) {
    console.warn(`could not read manifest ${manifestKey} for a poster`, error);
    return null;
  }
}
