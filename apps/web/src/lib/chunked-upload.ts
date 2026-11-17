// Uploads in pieces ("resumable uploads"), independent of what is uploaded.
//
// Why: the hosting proxy (Railway) cuts off a request whose body takes more than 5 minutes to
// arrive, and any request after 15 minutes, so a large video can't be sent in one request over a
// phone connection. The client sends the file as numbered pieces of PIECE_BYTES each; every piece
// is its own short request, retried on its own when the connection drops. The server keeps the
// pieces on local disk until the client asks for them to be joined.
//
// Layout: <root>/<uploadId>/meta.json plus one "<index>.part" file per confirmed piece. A piece is
// written to a temp file and renamed into place, so a piece on disk is always complete. Which
// pieces arrived is read from the directory, so a crash between writes loses nothing confirmed.
//
// A session is found again by the file's fingerprint (computed by the client from its name, size,
// modification time and a hash of its first and last bytes), so picking the same file again after
// the app was closed carries on from the pieces already here. Sessions not touched for
// SESSION_IDLE_MS are deleted. The app runs as a single process, so in-process locks are enough;
// a deploy (new machine) loses the pieces, and the client then starts that file again.
//
// Nothing here knows about phones or loops: a route decides who may upload what, when to count
// an upload, and what to do with the joined file (see app/api/m/uploads).

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { ApiError } from "./http";

/** Size of every piece but the last. A few MB: about 16 s each at a slow 250 KB/s upload. */
export const PIECE_BYTES = 4 * 1024 * 1024;
/** A session nobody has touched for this long is abandoned and deleted. */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** How long a finished session is kept (without its pieces) so a client that missed the answer can ask again. */
export const FINISHED_KEEP_MS = 6 * 60 * 60 * 1000;

export type UploadSessionMeta<T = unknown> = {
  id: string;
  fingerprint: string;
  fileName: string;
  size: number;
  pieceBytes: number;
  pieceCount: number;
  createdAt: string;
  updatedAt: string;
  /** "open": taking pieces. "finished": joined and handed over (pieces deleted). */
  status: "open" | "finished";
  /** Whatever the route wants to keep with the upload (name, target, the result once finished). */
  data: T;
};

export type UploadSessionState<T = unknown> = UploadSessionMeta<T> & { received: number[]; receivedBytes: number };

export function uploadSessionsRoot() {
  return process.env.UPLOAD_SESSIONS_DIR || path.join(os.tmpdir(), "orison-upload-sessions");
}

export function pieceCountFor(size: number, pieceBytes = PIECE_BYTES) {
  return Math.max(1, Math.ceil(size / pieceBytes));
}

/** Expected length of piece `index` of a file of `size` bytes. */
export function pieceLength(index: number, size: number, pieceBytes = PIECE_BYTES) {
  const count = pieceCountFor(size, pieceBytes);
  if (index < 0 || index >= count || !Number.isInteger(index)) return -1;
  if (size === 0) return 0;
  return index === count - 1 ? size - pieceBytes * (count - 1) : pieceBytes;
}

const ID_PATTERN = /^[a-f0-9]{32}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9:._-]{8,200}$/;

function sessionDir(root: string, id: string) {
  if (!ID_PATTERN.test(id)) throw new ApiError("Upload not found", 404);
  return path.join(root, id);
}

// One operation at a time per session (writing the same piece twice, finishing while a piece
// arrives). Keyed by session id; resolves in order.
const locks = new Map<string, Promise<unknown>>();
async function withLock<R>(key: string, task: () => Promise<R>): Promise<R> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  try {
    return await next;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

async function readMeta<T>(dir: string): Promise<UploadSessionMeta<T> | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as UploadSessionMeta<T>;
  } catch {
    return null;
  }
}

async function writeMeta(dir: string, meta: UploadSessionMeta<unknown>) {
  const temp = path.join(dir, `meta.json.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(meta));
  await rename(temp, path.join(dir, "meta.json"));
}

async function receivedPieces(dir: string, meta: UploadSessionMeta<unknown>) {
  const received: number[] = [];
  let receivedBytes = 0;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { received, receivedBytes };
  }
  for (const name of names) {
    const match = /^(\d+)\.part$/.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    const expected = pieceLength(index, meta.size, meta.pieceBytes);
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info && expected >= 0 && info.size === expected) {
      received.push(index);
      receivedBytes += info.size;
    }
  }
  received.sort((a, b) => a - b);
  return { received, receivedBytes };
}

async function stateOf<T>(dir: string, meta: UploadSessionMeta<T>): Promise<UploadSessionState<T>> {
  if (meta.status === "finished") {
    return { ...meta, received: [], receivedBytes: meta.size };
  }
  return { ...meta, ...(await receivedPieces(dir, meta)) };
}

async function touch(dir: string, meta: UploadSessionMeta<unknown>) {
  meta.updatedAt = new Date().toISOString();
  await writeMeta(dir, meta);
}

/**
 * Open a session for a file, or reopen the open one with the same fingerprint (so the pieces
 * already sent are kept). `update` replaces the route's data on a reopened session; `isNew` says
 * which happened, so the route counts a video once.
 */
export async function openUploadSession<T>(options: {
  fingerprint: string;
  fileName: string;
  size: number;
  maxBytes: number;
  tooLargeMessage: string;
  data: T;
  root?: string;
}): Promise<{ session: UploadSessionState<T>; isNew: boolean }> {
  const root = options.root ?? uploadSessionsRoot();
  if (!FINGERPRINT_PATTERN.test(options.fingerprint)) throw new ApiError("Invalid file fingerprint", 400);
  if (!Number.isInteger(options.size) || options.size < 0) throw new ApiError("Invalid file size", 400);
  if (options.size === 0) throw new ApiError("The file is empty", 400);
  if (options.size > options.maxBytes) throw new ApiError(options.tooLargeMessage, 413);
  await mkdir(root, { recursive: true });
  void sweepAbandonedUploads({ root }).catch(() => undefined);

  return withLock(`open:${options.fingerprint}`, async () => {
    const existing = await findByFingerprint<T>(root, options.fingerprint, options.size);
    if (existing) {
      const dir = path.join(root, existing.id);
      return withLock(existing.id, async () => {
        const meta = (await readMeta<T>(dir)) ?? existing;
        meta.fileName = options.fileName;
        meta.data = options.data;
        await touch(dir, meta);
        return { session: await stateOf(dir, meta), isNew: false };
      });
    }
    const id = randomBytes(16).toString("hex");
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta: UploadSessionMeta<T> = {
      id,
      fingerprint: options.fingerprint,
      fileName: options.fileName,
      size: options.size,
      pieceBytes: PIECE_BYTES,
      pieceCount: pieceCountFor(options.size),
      createdAt: now,
      updatedAt: now,
      status: "open",
      data: options.data,
    };
    await writeMeta(dir, meta);
    return { session: { ...meta, received: [], receivedBytes: 0 }, isNew: true };
  });
}

async function findByFingerprint<T>(root: string, fingerprint: string, size: number) {
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  let best: UploadSessionMeta<T> | null = null;
  for (const name of names) {
    if (!ID_PATTERN.test(name)) continue;
    const meta = await readMeta<T>(path.join(root, name));
    if (!meta || meta.status !== "open" || meta.fingerprint !== fingerprint || meta.size !== size) continue;
    if (!best || meta.updatedAt > best.updatedAt) best = meta;
  }
  return best;
}

export async function getUploadSession<T>(id: string, root = uploadSessionsRoot()) {
  const dir = sessionDir(root, id);
  const meta = await readMeta<T>(dir);
  if (!meta) throw new ApiError("Upload not found. It may have expired, or the server restarted; start it again.", 404);
  return stateOf(dir, meta);
}

/**
 * Store piece `index` from `body`. The piece must be exactly as long as expected (the last one is
 * shorter), and match `sha256` (hex) when given. Storing a piece that is already here is fine
 * (a retry whose first answer was lost). `check(index, filePath)` may inspect the piece before it
 * counts (for example the first piece's file type) and throw to refuse it.
 */
export async function putUploadPiece(options: {
  id: string;
  index: number;
  body: ReadableStream<Uint8Array> | null;
  sha256?: string | null;
  root?: string;
  check?: (index: number, filePath: string) => Promise<void>;
}) {
  const root = options.root ?? uploadSessionsRoot();
  const dir = sessionDir(root, options.id);
  const meta = await readMeta(dir);
  if (!meta) throw new ApiError("Upload not found. It may have expired, or the server restarted; start it again.", 404);
  if (meta.status !== "open") throw new ApiError("This upload is already complete", 409);
  const expected = pieceLength(options.index, meta.size, meta.pieceBytes);
  if (expected < 0) throw new ApiError(`There is no piece ${options.index} in this upload`, 400);
  if (!options.body) throw new ApiError("The request body must be the piece", 400);

  // Receive into a temp file first: never more than the expected length.
  const temp = path.join(dir, `${options.index}.part.${randomBytes(4).toString("hex")}.tmp`);
  const hash = createHash("sha256");
  let length = 0;
  const reader = options.body.getReader();
  const file = createWriteStream(temp);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expected) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(`Piece ${options.index} is larger than expected (${expected} bytes)`, 413);
      }
      hash.update(value);
      if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
    if (length !== expected) throw new ApiError(`Piece ${options.index} is incomplete (${length} of ${expected} bytes)`, 400);
    if (options.sha256 && hash.digest("hex") !== options.sha256.toLowerCase()) {
      throw new ApiError(`Piece ${options.index} arrived damaged; send it again`, 400);
    }
    if (options.check) await options.check(options.index, temp);
    return await withLock(options.id, async () => {
      const current = await readMeta(dir);
      if (!current || current.status !== "open") throw new ApiError("Upload not found", 404);
      await rename(temp, path.join(dir, `${options.index}.part`));
      await touch(dir, current);
      return stateOf(dir, current);
    });
  } finally {
    file.destroy();
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * Join the pieces into one file in a fresh temp folder (named with `tempPrefix`, which the server's
 * start-up cleanup knows) and hand it to `consume`, which takes ownership of the folder when it
 * returns and gives back what the client should get. `consume` must throw only before it has
 * handed the folder on: if it throws, the folder is removed here and the pieces are kept (the
 * client may try again). Only once: the result is stored, the pieces deleted, and a repeated call
 * (the client missed the answer) returns the stored result.
 */
export async function finishUploadSession<T, R>(options: {
  id: string;
  tempPrefix: string;
  root?: string;
  consume: (file: { tempDir: string; filePath: string; meta: UploadSessionMeta<T> }) => Promise<R>;
  storeResult: (data: T, result: R) => T;
  readResult: (data: T) => R | null;
}): Promise<R> {
  const root = options.root ?? uploadSessionsRoot();
  const dir = sessionDir(root, options.id);
  return withLock(options.id, async () => {
    const meta = await readMeta<T>(dir);
    if (!meta) throw new ApiError("Upload not found. It may have expired, or the server restarted; start it again.", 404);
    if (meta.status === "finished") {
      const result = options.readResult(meta.data);
      if (result !== null) return result;
      throw new ApiError("This upload was already finished", 409);
    }
    const { received } = await receivedPieces(dir, meta);
    if (received.length !== meta.pieceCount) {
      throw new ApiError(`Not all of the file has arrived yet (${received.length} of ${meta.pieceCount} pieces)`, 409, {
        received,
      });
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
    const filePath = path.join(tempDir, safeName(meta.fileName));
    let handedOver = false;
    try {
      const out = createWriteStream(filePath);
      for (let index = 0; index < meta.pieceCount; index += 1) {
        await pipeline(createReadStream(path.join(dir, `${index}.part`)), out, { end: false });
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      const joined = await stat(filePath);
      if (joined.size !== meta.size) throw new ApiError("The joined file has the wrong size; upload it again", 500);
      const result = await options.consume({ tempDir, filePath, meta });
      handedOver = true;
      meta.status = "finished";
      meta.data = options.storeResult(meta.data, result);
      await touch(dir, meta);
      await removePieces(dir);
      return result;
    } catch (error) {
      if (!handedOver) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

function safeName(fileName: string) {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.length > 0 ? base : "upload.bin";
}

async function removePieces(dir: string) {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name !== "meta.json") await rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

export async function cancelUploadSession(id: string, root = uploadSessionsRoot()) {
  const dir = sessionDir(root, id);
  await withLock(id, () => rm(dir, { recursive: true, force: true }));
}

let lastSweep = 0;
/**
 * Delete sessions nobody has touched for SESSION_IDLE_MS (and finished ones after
 * FINISHED_KEEP_MS), plus stray folders. Cheap; runs at most every 10 minutes unless forced.
 */
export async function sweepAbandonedUploads(options: { root?: string; now?: number; force?: boolean } = {}) {
  const now = options.now ?? Date.now();
  if (!options.force && now - lastSweep < 10 * 60 * 1000) return [] as string[];
  lastSweep = now;
  const root = options.root ?? uploadSessionsRoot();
  const removed: string[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, name);
    if (!ID_PATTERN.test(name)) continue;
    const meta = await readMeta(dir);
    let last: number;
    if (meta) {
      last = Date.parse(meta.updatedAt);
    } else {
      last = (await stat(dir).catch(() => null))?.mtimeMs ?? 0;
    }
    const limit = meta?.status === "finished" ? FINISHED_KEEP_MS : SESSION_IDLE_MS;
    if (now - last < limit) continue;
    await withLock(name, () => rm(dir, { recursive: true, force: true }));
    removed.push(name);
  }
  return removed;
}
