// Desktop publishing of slot-built loops, as a background job in the web process.
//
// - Starting a publish validates the loop, claims it (publishJobId) and returns at once; the
//   compile runs in the background through the process-wide media limiter (one ffmpeg job at a
//   time, shared with phone uploads and asset processing). The builder and the loops list poll.
// - The loop's status does not change while it compiles: a live loop stays live on its current
//   video until the new one is ready, then one conditional UPDATE swaps everything in at once.
// - Unchanged content creates nothing new: same picture and sound reuse the compiled video; same
//   manifest too reuses the manifest (cabs are told exactly what they were told before).
// - An interrupted job (process killed: deploy, crash) is detected from its heartbeat
//   (lib/publish-state.ts) and shown as failed; it can be retried or the loop deleted.
// - Superseded objects (old video, manifest, poster, stills) are kept for RETIRE_GRACE_MS so a cab
//   in the middle of downloading the old version can finish, then deleted. A deleted loop's
//   objects are deleted with it.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { prisma, Prisma, type Asset, type Loop, type Slot, type SlotContent } from "@orison/db";

import { logActivity } from "./activity";
import { purgeUnusedHiddenAssets } from "./asset-removal";
import { getCmsSettings, loopFrameFrom } from "./cms-settings";
import { compileLoopVideo, CompileError, type CompiledLoopVideo } from "./loop-compile";
import { buildCompilePlan, buildSlotLoopManifest, draftKeyOf, PlanError, type CompiledProbe, type CompilePlan, type LoopFrame, type ManifestStill, type PlanSlot } from "./loop-plan";
import { mediaJobLimiter, processSingleton } from "./job-limits";
import { generateContactSheet } from "./loop-poster";
import { checksumFile } from "./media";
import {
  INTERRUPTED_PUBLISH_MESSAGE,
  PUBLISH_HEARTBEAT_MS,
  PUBLISH_STALE_MS,
  blockedByPublish,
  publishJobView,
  publishWork,
  type PublishProgress,
  type PublishStage,
} from "./publish-state";
import { deleteObject, getPublicUrl, putObject, putObjectFromFile, readObject } from "./storage";
import { STALE_PUBLISHING_MS } from "./upload-rules";

const execFileAsync = promisify(execFile);

export const RETIRE_GRACE_MS = 6 * 60 * 60 * 1000;

/** Identifies this server process start (see publishJobView). */
export const BOOT_ID: string = processSingleton("publish-boot-id", () => randomUUID());

export class PublishRefused extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

type LoopWithContents = Loop & {
  slots: Array<Slot & { staticCreative: Asset | null; contents: Array<SlotContent & { asset: Asset }> }>;
};

async function loadLoopForPublish(loopId: string) {
  return (await prisma.loop.findUnique({
    where: { id: loopId },
    include: {
      slots: {
        orderBy: { position: "asc" },
        include: { staticCreative: true, contents: { orderBy: { orderInSlot: "asc" }, include: { asset: true } } },
      },
    },
  })) as LoopWithContents | null;
}

function planSlotsOf(loop: LoopWithContents): PlanSlot[] {
  return loop.slots.map((slot) => ({
    position: slot.position,
    contents: slot.contents.map((content) => ({
      assetId: content.assetId,
      orderInSlot: content.orderInSlot,
      startTimeMs: content.startTimeMs,
      durationMs: content.durationMs,
      contentType: content.contentType,
      asset: content.asset,
    })),
  }));
}

function assertAssetsReady(loop: LoopWithContents) {
  for (const slot of loop.slots) {
    const notReady = slot.contents.find((content) => content.asset.status !== "READY");
    if (notReady) {
      throw new PlanError(`Slot ${slot.position + 1}: "${notReady.asset.filename}" is not ready (${notReady.asset.status.toLowerCase()}).`);
    }
    if (slot.staticCreative && slot.staticCreative.status !== "READY") {
      throw new PlanError(`Slot ${slot.position + 1}: its still image "${slot.staticCreative.filename}" is not ready.`);
    }
  }
}

/** The compile plan for the loop as it is saved now (throws PlanError naming what is wrong). */
export async function planForLoop(loop: LoopWithContents, frame?: LoopFrame): Promise<CompilePlan> {
  assertAssetsReady(loop);
  return buildCompilePlan(planSlotsOf(loop), frame ?? loopFrameFrom(await getCmsSettings()));
}

// ---------------------------------------------------------------------------------------------
// Shared fallback still

const FALLBACK_STILL_SETTING = "loop-fallback-still";
const FALLBACK_STILL_VERSION = 1;

/**
 * The still a cab shows between journeys for a slot with no still image of its own: the Orison
 * logo in gold on navy, at the loop frame size. One shared object (made once per frame size), so
 * publishes no longer upload a new placeholder each time.
 */
export async function ensureFallbackStill(frame: LoopFrame): Promise<ManifestStill> {
  const row = await prisma.systemSetting.findUnique({ where: { key: FALLBACK_STILL_SETTING } });
  const stored = row?.value as { key?: string; checksum?: string; fileSizeBytes?: number; width?: number; height?: number; version?: number } | undefined;
  if (stored?.key && stored.checksum && stored.width === frame.width && stored.height === frame.height && stored.version === FALLBACK_STILL_VERSION) {
    return { assetId: null, url: getPublicUrl(stored.key), checksum: stored.checksum, fileSizeBytes: stored.fileSizeBytes ?? 0 };
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), "orison-loop-still-"));
  try {
    const output = path.join(workDir, "still.jpg");
    const logoWidth = Math.round((frame.width * 0.56) / 2) * 2;
    const logoHeight = Math.round((logoWidth * 542) / 1658 / 2) * 2;
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x0c1322:s=${frame.width}x${frame.height}`,
        "-i",
        path.join(process.cwd(), "assets", "orison-logo.png"),
        "-f",
        "lavfi",
        "-i",
        `color=c=0xd4af5a:s=${logoWidth}x${logoHeight}`,
        "-filter_complex",
        `[1:v]scale=${logoWidth}:${logoHeight},format=rgba,alphaextract,setsar=1[m];[2:v]format=yuva420p,setsar=1[g];[g][m]alphamerge[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2`,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        output,
      ],
      { timeout: 60_000 },
    );
    const checksum = await checksumFile(output);
    const fileSizeBytes = (await stat(output)).size;
    const key = `system/fallback-still/${checksum.slice(7, 23)}-${frame.width}x${frame.height}.jpg`;
    await putObjectFromFile({ key, filePath: output, contentType: "image/jpeg" });
    const value = { key, checksum, fileSizeBytes, width: frame.width, height: frame.height, version: FALLBACK_STILL_VERSION };
    await prisma.systemSetting.upsert({ where: { key: FALLBACK_STILL_SETTING }, update: { value }, create: { key: FALLBACK_STILL_SETTING, value } });
    return { assetId: null, url: getPublicUrl(key), checksum, fileSizeBytes };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Storage keys referenced by a manifest

/** The storage key behind a URL this app produced (getPublicUrl), or null. */
export function storageKeyFromUrl(url: string | null | undefined) {
  if (!url) return null;
  const marker = "/api/storage/";
  const at = url.indexOf(marker);
  if (at >= 0) return decodeURIComponent(url.slice(at + marker.length));
  const cdn = process.env.CDN_BASE_URL?.replace(/\/$/, "");
  if (cdn && url.startsWith(`${cdn}/`)) return decodeURIComponent(url.slice(cdn.length + 1));
  return null;
}

/** Objects that belong to this loop alone (never shared assets or the shared fallback still). */
function ownedBy(loopId: string, key: string | null | undefined): key is string {
  return Boolean(key && (key.startsWith(`loops/${loopId}/`) || key.startsWith(`manifests/${loopId}/`)));
}

async function readManifest(key: string | null) {
  if (!key) return null;
  try {
    return JSON.parse((await readObject(key)).toString("utf8")) as Record<string, unknown> & {
      slots?: Array<{ staticImageUrl?: string | null }>;
      video?: Record<string, unknown>;
      compiledVideoChecksum?: string | null;
    };
  } catch (error) {
    console.warn(`could not read manifest ${key}`, error);
    return null;
  }
}

/** Every object a published version of the loop uses that belongs to the loop. */
async function ownedObjectsOf(loop: Pick<Loop, "id" | "manifestKey" | "compiledVideoKey" | "posterKey">) {
  const keys = new Set<string>();
  for (const key of [loop.manifestKey, loop.compiledVideoKey, loop.posterKey]) {
    if (ownedBy(loop.id, key)) keys.add(key);
  }
  const manifest = await readManifest(loop.manifestKey);
  for (const slot of manifest?.slots ?? []) {
    const key = storageKeyFromUrl(slot.staticImageUrl ?? null);
    if (ownedBy(loop.id, key)) keys.add(key);
  }
  return keys;
}

type RetiredObject = { key: string; retiredAt: string };

function parseRetired(value: unknown): RetiredObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is RetiredObject =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as RetiredObject).key === "string" && typeof (entry as RetiredObject).retiredAt === "string",
  );
}

/** Split retired objects into those due for deletion and those still in their grace period. */
export function dueRetired(entries: RetiredObject[], now: Date, graceMs = RETIRE_GRACE_MS) {
  const due: RetiredObject[] = [];
  const keep: RetiredObject[] = [];
  for (const entry of entries) {
    (now.getTime() - Date.parse(entry.retiredAt) >= graceMs ? due : keep).push(entry);
  }
  return { due, keep };
}

/** Delete superseded objects whose grace period is over. */
export async function sweepRetiredObjects(options: { now?: Date; graceMs?: number; loopId?: string } = {}) {
  const now = options.now ?? new Date();
  const rows = await prisma.loop.findMany({
    where: { retiredObjects: { not: Prisma.DbNull }, ...(options.loopId ? { id: options.loopId } : {}) },
    select: { id: true, retiredObjects: true, manifestKey: true, compiledVideoKey: true, posterKey: true },
  });
  let deleted = 0;
  for (const row of rows) {
    const entries = parseRetired(row.retiredObjects);
    const { due, keep } = dueRetired(entries, now, options.graceMs);
    if (due.length === 0) continue;
    const inUse = new Set([row.manifestKey, row.compiledVideoKey, row.posterKey]);
    for (const entry of due) {
      if (inUse.has(entry.key)) continue;
      await deleteObject(entry.key).catch((error) => console.warn(`could not delete ${entry.key}`, error));
      deleted += 1;
    }
    await prisma.loop.updateMany({
      where: { id: row.id, retiredObjects: { equals: row.retiredObjects as Prisma.InputJsonValue } },
      data: { retiredObjects: keep.length ? keep : Prisma.DbNull },
    });
  }
  return deleted;
}

// Sweep once an hour while the server runs (the timer does not keep the process alive).
processSingleton("retired-object-sweeper", () => {
  const timer = setInterval(() => {
    void sweepRetiredObjects().catch((error) => console.warn("retired object sweep failed", error));
  }, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
});

// ---------------------------------------------------------------------------------------------
// Interrupted publishes

/**
 * Clear publish jobs whose process died (stale heartbeat): the loop keeps what it had (a live
 * loop is still live on its previous version), shows why, and can be published again or deleted.
 * Objects the dead job had already uploaded are removed. Also repairs loops left in PUBLISHING by
 * the publish code before this change (it took the loop off air for the whole compile).
 */
export async function recoverInterruptedPublishes(loopId?: string, now = new Date()) {
  const rows = await prisma.loop.findMany({
    where: { publishJobId: { not: null }, ...(loopId ? { id: loopId } : {}) },
    select: { id: true, name: true, publishJobId: true, publishHeartbeatAt: true, publishProgress: true, manifestKey: true, compiledVideoKey: true, posterKey: true },
  });
  for (const row of rows) {
    const view = publishJobView(row, now, BOOT_ID);
    if (view.kind !== "interrupted") continue;
    const cleared = await prisma.loop.updateMany({
      where: { id: row.id, publishJobId: view.jobId },
      data: { publishJobId: null, publishHeartbeatAt: null, publishProgress: Prisma.DbNull, publishError: INTERRUPTED_PUBLISH_MESSAGE },
    });
    if (cleared.count === 0) continue;
    const inUse = new Set([row.manifestKey, row.compiledVideoKey, row.posterKey]);
    for (const key of view.progress?.pendingKeys ?? []) {
      if (!inUse.has(key)) await deleteObject(key).catch(() => undefined);
    }
    console.warn(`publish of loop ${row.id} was interrupted; cleared`);
  }

  // Legacy: desktop loops (autoLive, built in slots) stuck in PUBLISHING with no job.
  await prisma.loop.updateMany({
    where: {
      status: "PUBLISHING",
      autoLive: true,
      publishJobId: null,
      updatedAt: { lt: new Date(now.getTime() - STALE_PUBLISHING_MS) },
      slots: { some: {} },
      ...(loopId ? { id: loopId } : {}),
    },
    data: { status: "DRAFT", publishError: "An earlier publish was interrupted, so this loop is not on air. Publish it again." },
  });
}

/** The job view for a loop, after clearing it if it was interrupted. */
export async function currentPublishJob(loopId: string) {
  await recoverInterruptedPublishes(loopId);
  const row = await prisma.loop.findUnique({
    where: { id: loopId },
    select: { publishJobId: true, publishHeartbeatAt: true, publishProgress: true },
  });
  return row ? publishJobView(row, new Date(), BOOT_ID) : null;
}

/** Throws PublishRefused if a publish is running for the loop. */
export async function assertNotPublishing(loopId: string, action: Parameters<typeof blockedByPublish>[1]) {
  const view = await currentPublishJob(loopId);
  const message = view ? blockedByPublish(view, action) : null;
  if (message) throw new PublishRefused(message);
}

// ---------------------------------------------------------------------------------------------
// Starting a publish

export type StartPublishResult =
  | { kind: "started"; jobId: string }
  | { kind: "already-running"; jobId: string }
  | { kind: "on-air"; message: string };

/**
 * Start publishing a loop. Validates first (PlanError for a loop that is not ready), then claims
 * the loop and runs the compile in the background. A pre-built (direct upload) loop has nothing
 * to compile: it is put on air at once.
 */
export async function startLoopPublish(loopId: string, user: { id: string; name?: string | null }): Promise<StartPublishResult> {
  await recoverInterruptedPublishes(loopId);
  const loop = await loadLoopForPublish(loopId);
  if (!loop) throw new PublishRefused("Loop not found", 404);

  const view = publishJobView(loop);
  if (view.kind === "running") return { kind: "already-running", jobId: view.jobId };

  if (loop.slots.length === 0) {
    if (!loop.compiledVideoKey || !loop.manifestUrl) {
      throw new PublishRefused("This loop has no video yet, so it cannot be put on air.", 400);
    }
    if (loop.status === "PUBLISHING") {
      throw new PublishRefused("This video is still being processed.", 409);
    }
    if (!loop.autoLive) {
      throw new PublishRefused("This video was uploaded from the phone app. Choose where it plays from the phone app.", 409);
    }
    await prisma.loop.update({
      where: { id: loop.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), publishedBy: user.id, publishError: null },
    });
    await logActivity("LOOP_PUBLISHED", `Loop ${loop.name} put on air`, { loopId: loop.id, publishedByUserId: user.id, reused: true });
    return { kind: "on-air", message: "It is on air now." };
  }

  // Validate now so the builder gets the reason straight away.
  await planForLoop(loop);

  const jobId = randomUUID();
  const now = new Date();
  const progress: PublishProgress = { stage: "queued", startedAt: now.toISOString(), userId: user.id, bootId: BOOT_ID };
  const claimed = await prisma.loop.updateMany({
    where: { id: loop.id, publishJobId: null },
    data: { publishJobId: jobId, publishHeartbeatAt: now, publishProgress: progress as Prisma.InputJsonValue, publishError: null },
  });
  if (claimed.count === 0) {
    const current = await currentPublishJob(loop.id);
    if (current?.kind === "running") return { kind: "already-running", jobId: current.jobId };
    throw new PublishRefused("The loop changed while publishing was starting. Try again.");
  }

  void runPublishJob({ jobId, loopId: loop.id, userId: user.id, lost: false }).catch((error) =>
    console.error(`publish job ${jobId} crashed`, error),
  );
  return { kind: "started", jobId };
}

// ---------------------------------------------------------------------------------------------
// The job

type Job = { jobId: string; loopId: string; userId: string; lost: boolean; progress?: PublishProgress; lastWrite?: number };

class JobLost extends Error {}

async function touch(job: Job, progress?: PublishProgress) {
  const now = new Date();
  const rows = progress
    ? await prisma.$executeRaw`UPDATE "Loop" SET "publishHeartbeatAt" = ${now}, "publishProgress" = ${JSON.stringify(progress)}::jsonb WHERE "id" = ${job.loopId} AND "publishJobId" = ${job.jobId}`
    : await prisma.$executeRaw`UPDATE "Loop" SET "publishHeartbeatAt" = ${now} WHERE "id" = ${job.loopId} AND "publishJobId" = ${job.jobId}`;
  if (rows === 0) job.lost = true;
}

async function setStage(job: Job, stage: PublishStage, done?: number, total?: number, extra: Partial<PublishProgress> = {}) {
  const previous = job.progress;
  job.progress = { ...(previous ?? { startedAt: new Date().toISOString(), userId: job.userId, bootId: BOOT_ID }), ...extra, stage, done, total };
  const now = Date.now();
  // Stage changes are written at once; counts at most once a second.
  if (!previous || previous.stage !== stage || !job.lastWrite || now - job.lastWrite > 1000 || done === total || extra.pendingKeys) {
    job.lastWrite = now;
    await touch(job, job.progress).catch((error) => console.warn("could not record publish progress", error));
  }
  if (job.lost) throw new JobLost();
}

async function runPublishJob(job: Job) {
  const ticker = setInterval(() => {
    void touch(job).catch((error) => console.warn("publish heartbeat failed", error));
  }, PUBLISH_HEARTBEAT_MS);
  ticker.unref?.();
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(path.join(os.tmpdir(), "orison-loop-publish-"));
    const dir = workDir;
    await mediaJobLimiter().run(() => publishNow(job, dir));
  } catch (error) {
    await failJob(job, error);
  } finally {
    clearInterval(ticker);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function failJob(job: Job, error: unknown) {
  const pending = job.progress?.pendingKeys ?? [];
  if (!(error instanceof JobLost)) {
    const message =
      error instanceof CompileError || error instanceof PlanError || error instanceof PublishRefused
        ? error.message
        : "Publishing failed unexpectedly. Nothing changed on any cab. Try again; if it fails again, the details are in the server log.";
    if (!(error instanceof CompileError || error instanceof PlanError || error instanceof PublishRefused)) {
      console.error(`publish of loop ${job.loopId} failed`, error);
    }
    await prisma.loop
      .updateMany({
        where: { id: job.loopId, publishJobId: job.jobId },
        data: { publishJobId: null, publishHeartbeatAt: null, publishProgress: Prisma.DbNull, publishError: message },
      })
      .catch((updateError) => console.error("could not record publish failure", updateError));
  }
  const row = await prisma.loop
    .findUnique({ where: { id: job.loopId }, select: { manifestKey: true, compiledVideoKey: true, posterKey: true } })
    .catch(() => null);
  const inUse = new Set([row?.manifestKey, row?.compiledVideoKey, row?.posterKey]);
  for (const key of pending) {
    if (!inUse.has(key)) await deleteObject(key).catch(() => undefined);
  }
}

function probeFromManifest(video: Record<string, unknown> | undefined): CompiledProbe | null {
  if (!video || typeof video.width !== "number") return null;
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  return {
    width: num(video.width),
    height: num(video.height),
    frameRate: num(video.frameRate),
    videoCodec: String(video.codec ?? "h264"),
    videoProfile: typeof video.profile === "string" ? video.profile : null,
    pixFmt: typeof video.pixelFormat === "string" ? video.pixelFormat : null,
    audioCodec: typeof video.audioCodec === "string" ? video.audioCodec : null,
    audioChannels: num(video.audioChannels),
    audioSampleRate: num(video.audioSampleRate),
    videoFrames: num(video.frameCount),
    videoDurationMs: num(video.videoDurationMs),
    audioDurationMs: num(video.audioDurationMs),
    containerDurationMs: num(video.videoDurationMs),
    keyframes: [],
  };
}

async function loadSafetyForManifest(settings: Awaited<ReturnType<typeof getCmsSettings>>) {
  if (!settings.safetyVideoAssetId) return null;
  const asset = await prisma.asset.findUnique({ where: { id: settings.safetyVideoAssetId } });
  if (!asset || asset.status !== "READY" || asset.category !== "SAFETY_MESSAGE" || !asset.mimeType) return null;
  const durationMs = asset.mimeType.startsWith("image/") ? settings.safetyMessageDurationSeconds * 1000 : asset.durationMs ?? 0;
  if (durationMs <= 0) return null;
  return { url: getPublicUrl(asset.s3Key), checksum: asset.checksum ?? "", durationMs, mimeType: asset.mimeType, fileSizeBytes: asset.fileSize };
}

/** Times (ms) for a poster contact sheet: a moment into each distinct advert, in slot order. */
export function contactSheetTimes(slots: Array<{ position: number; contents: Array<{ contentType: string; assetId: string; startTimeMs: number; durationMs: number }> }>, slotDurationMs: number, max = 4) {
  const seen = new Set<string>();
  const times: number[] = [];
  for (const slot of slots.slice().sort((a, b) => a.position - b.position)) {
    const advert = slot.contents.find((content) => content.contentType === "ADVERTISEMENT");
    if (!advert || seen.has(advert.assetId)) continue;
    seen.add(advert.assetId);
    times.push(slot.position * slotDurationMs + advert.startTimeMs + Math.min(1000, Math.floor(advert.durationMs / 2)));
    if (times.length >= max) break;
  }
  return times;
}

async function publishNow(job: Job, workDir: string) {
  await setStage(job, "fetching", 0, 0);
  const [loop, settings] = await Promise.all([loadLoopForPublish(job.loopId), getCmsSettings()]);
  if (!loop) throw new JobLost();
  const frame = loopFrameFrom(settings);
  const plan = await planForLoop(loop, frame);
  const [fallbackStill, safetyVideo, currentManifest] = await Promise.all([
    ensureFallbackStill(frame),
    loadSafetyForManifest(settings),
    loop.compiledContentKey === plan.contentKey ? readManifest(loop.manifestKey) : Promise.resolve(null),
  ]);

  // Reuse the compiled video when its picture and sound would be the same.
  let compiled: CompiledLoopVideo | null = null;
  let video: { key: string; checksum: string; fileSizeBytes: number; probe: CompiledProbe };
  const reusedProbe = loop.compiledVideoKey && currentManifest ? probeFromManifest(currentManifest.video) : null;
  if (reusedProbe && loop.compiledVideoKey && currentManifest?.compiledVideoChecksum) {
    video = {
      key: loop.compiledVideoKey,
      checksum: currentManifest.compiledVideoChecksum,
      fileSizeBytes: Number(currentManifest.video?.fileSizeBytes ?? 0),
      probe: reusedProbe,
    };
  } else {
    compiled = await compileLoopVideo(plan, workDir, (stage, done, total) => {
      void setStage(job, stage, done, total).catch(() => undefined);
    });
    if (job.lost) throw new JobLost();
    const stamp = `${Date.now()}-${randomUUID()}`;
    video = {
      key: `loops/${loop.id}/${stamp}.mp4`,
      checksum: await checksumFile(compiled.outputPath),
      fileSizeBytes: compiled.fileSizeBytes,
      probe: compiled.probe,
    };
  }

  const publishedAt = new Date();
  const built = buildSlotLoopManifest({
    loop: { id: loop.id, name: loop.name, targetGroupId: loop.targetGroupId },
    plan,
    slots: loop.slots.map((slot) => ({
      position: slot.position,
      staticCreative: slot.staticCreative
        ? {
            assetId: slot.staticCreative.id,
            url: getPublicUrl(slot.staticCreative.s3Key),
            checksum: slot.staticCreative.checksum ?? "",
            fileSizeBytes: slot.staticCreative.fileSize,
          }
        : null,
      contents: slot.contents.map((content) => ({ ...content, asset: content.asset })),
    })),
    assetUrl: getPublicUrl,
    fallbackStill,
    safetyVideo,
    video: { url: getPublicUrl(video.key), checksum: video.checksum, fileSizeBytes: video.fileSizeBytes, probe: video.probe },
    publishedAt,
  });

  const work = publishWork(loop, { compiledContentKey: plan.contentKey, manifestContentKey: built.manifestContentKey });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const manifestKey = work === "nothing" ? loop.manifestKey! : `manifests/${loop.id}/${stamp}.json`;
  const posterKey = compiled ? `loops/${loop.id}/${stamp}-poster.jpg` : loop.posterKey;
  const newKeys = [compiled ? video.key : null, work !== "nothing" ? manifestKey : null, compiled ? posterKey : null].filter(
    (key): key is string => Boolean(key),
  );

  if (newKeys.length) {
    await setStage(job, "uploading", 0, newKeys.length, { pendingKeys: newKeys });
    let uploaded = 0;
    if (compiled) {
      await putObjectFromFile({ key: video.key, filePath: compiled.outputPath, contentType: "video/mp4" });
      await setStage(job, "uploading", (uploaded += 1), newKeys.length);
      const posterPath = path.join(workDir, "poster.jpg");
      try {
        await generateContactSheet(compiled.outputPath, contactSheetTimes(loop.slots, plan.slotDurationMs), posterPath, frame);
        await putObjectFromFile({ key: posterKey!, filePath: posterPath, contentType: "image/jpeg" });
      } catch (error) {
        console.warn(`poster for loop ${loop.id} failed`, error);
      }
      await setStage(job, "uploading", (uploaded += 1), newKeys.length);
    }
    if (work !== "nothing") {
      await putObject({ key: manifestKey, body: Buffer.from(JSON.stringify(built.manifest, null, 2)), contentType: "application/json" });
      await setStage(job, "uploading", (uploaded += 1), newKeys.length);
    }
  }

  // Swap in atomically, only while this job still owns the loop.
  await setStage(job, "going-live");
  const previousObjects = work === "nothing" ? new Set<string>() : await ownedObjectsOf(loop);
  const keepKeys = new Set([video.key, manifestKey, posterKey]);
  const retiredNow = [...previousObjects].filter((key) => !keepKeys.has(key)).map((key) => ({ key, retiredAt: publishedAt.toISOString() }));
  const retired = [...parseRetired(loop.retiredObjects).filter((entry) => !keepKeys.has(entry.key)), ...retiredNow];

  const swapped = await prisma.loop.updateMany({
    where: { id: loop.id, publishJobId: job.jobId },
    data: {
      status: "PUBLISHED",
      ...(work === "nothing" ? {} : { version: { increment: 1 } }),
      publishedAt,
      publishedBy: job.userId,
      publishError: null,
      manifestKey,
      manifestUrl: getPublicUrl(manifestKey),
      compiledVideoKey: video.key,
      compiledVideoUrl: getPublicUrl(video.key),
      checksum: work === "nothing" ? loop.checksum : built.checksum,
      durationMs: Math.round(video.probe.videoDurationMs),
      posterKey: posterKey ?? null,
      compiledContentKey: plan.contentKey,
      publishedDraftKey: draftKeyOf(loop.slots, frame),
      manifestContentKey: work === "nothing" ? loop.manifestContentKey : built.manifestContentKey,
      retiredObjects: retired.length ? retired : Prisma.DbNull,
      publishJobId: null,
      publishHeartbeatAt: null,
      publishProgress: Prisma.DbNull,
    },
  });
  if (swapped.count === 0) {
    throw new JobLost();
  }

  await logActivity(
    "LOOP_PUBLISHED",
    work === "nothing"
      ? `Loop ${loop.name} published again with no changes (nothing new for cabs to download)`
      : work === "manifest"
        ? `Loop ${loop.name} published (same video, updated details)`
        : `Loop ${loop.name} published`,
    {
      loopId: loop.id,
      publishedByUserId: job.userId,
      work,
      checksum: work === "nothing" ? loop.checksum : built.checksum,
      compiledVideoKey: video.key,
      fileSizeBytes: video.fileSizeBytes,
      totalDurationMs: Math.round(video.probe.videoDurationMs),
      ...(compiled ? { encodeMs: compiled.encodeMs, segmentsEncoded: compiled.segmentsEncoded, assetsFetched: compiled.assetsFetched } : {}),
    },
  ).catch(() => undefined);

  await sweepRetiredObjects({ loopId: loop.id }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Deleting

/** Delete a loop and every object that belongs to it. Refused while live or publishing. */
export async function deleteLoopAndObjects(loopId: string) {
  await recoverInterruptedPublishes(loopId);
  const loop = await prisma.loop.findUnique({ where: { id: loopId } });
  if (!loop) throw new PublishRefused("Loop not found", 404);
  const view = publishJobView(loop);
  const blocked = blockedByPublish(view, "delete");
  if (blocked) throw new PublishRefused(blocked);
  if (loop.status === "PUBLISHED") throw new PublishRefused("Take this loop off air (Pause) before deleting it.");
  if (loop.status === "PUBLISHING") throw new PublishRefused("This video is still being processed and cannot be deleted yet.");

  const keys = await ownedObjectsOf(loop);
  for (const entry of parseRetired(loop.retiredObjects)) keys.add(entry.key);
  for (const key of view.kind === "interrupted" ? view.progress?.pendingKeys ?? [] : []) keys.add(key);

  const deleted = await prisma.loop.deleteMany({ where: { id: loop.id, publishJobId: loop.publishJobId } });
  if (deleted.count === 0) throw new PublishRefused("The loop changed while it was being deleted. Try again.");
  for (const key of keys) {
    await deleteObject(key).catch((error) => console.warn(`could not delete ${key}`, error));
  }
  await purgeUnusedHiddenAssets().catch((error) => console.warn("could not purge hidden assets", error));
  return { loop, deletedObjects: [...keys] };
}
