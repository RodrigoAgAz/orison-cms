// Sends a file to the server in pieces (server side: lib/chunked-upload.ts, app/api/m/uploads).
//
// The hosting proxy cuts off a request whose body takes more than 5 minutes, so the file goes up
// as pieces of a few MB, each its own short request. A piece that fails for want of a connection
// (or an answer) is sent again by itself, after a short wait that grows, and straight away when
// the phone says it is back online. Progress counts only pieces the server has confirmed.
//
// The server finds an upload again by the file's fingerprint, so starting the same file again
// (after the app was closed) carries on from the pieces it already has. If the server has lost
// the upload (a deploy or restart moves it to a fresh disk), it answers 404 and the file is
// started again from the beginning, by itself, while the app still holds it.
//
// No React here, so it can be tested with a fake fetch.

import type { AssignTarget } from "./types";

export const PIECE_TIMEOUT_MS = 120_000;
export const CONTROL_TIMEOUT_MS = 30_000;
/** Joining a 500 MB file and starting its preparation can take a little while. */
export const COMPLETE_TIMEOUT_MS = 120_000;
/** Server restarts tolerated in one upload before giving up. */
export const MAX_RESTARTS = 3;

export type OpenAnswer = {
  uploadId: string;
  size: number;
  pieceBytes: number;
  pieceCount: number;
  received: number[];
  receivedBytes: number;
  status: string;
  loopId: string | null;
  resumed?: boolean;
};

export class UploadRefused extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export class UploadCancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export type SendEvents = {
  /** The server knows this upload as `uploadId`; `confirmedBytes` of the file are already there. */
  onSession?: (session: OpenAnswer) => void;
  /** A piece was confirmed. */
  onProgress?: (progress: { confirmedBytes: number; piecesDone: number; pieceCount: number }) => void;
  /** "waiting": no connection or no answer, retrying by itself; "sending": going again. */
  onConnection?: (state: "sending" | "waiting") => void;
  /** The server had lost the upload (restart or deploy), so it starts again from the beginning. */
  onRestart?: (count: number) => void;
  /** All pieces are there; joining and handing over to preparation. */
  onFinishing?: () => void;
};

export type SendOptions = {
  file: Blob;
  fileName: string;
  name: string;
  target: AssignTarget | null;
  fingerprint: string;
  signal: AbortSignal;
  events?: SendEvents;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Resolves when the connection may be back (the browser's "online" event), or after `ms`. */
  waitForConnection?: (ms: number, signal: AbortSignal) => Promise<void>;
  sha256?: (data: ArrayBuffer) => Promise<string | null>;
  /** First wait before a retry; doubles to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
};

type Outcome =
  | { kind: "ok"; status: number; body: Record<string, unknown> | null }
  | { kind: "refused"; status: number; message: string; body: Record<string, unknown> | null }
  | { kind: "retry"; reason: string; status: number };

function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadCancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultWaitForConnection(ms: number, signal: AbortSignal) {
  if (typeof window === "undefined") return defaultSleep(ms, signal);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelled());
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      reject(new UploadCancelled());
    };
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function sha256Hex(data: ArrayBuffer): Promise<string | null> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) return null; // not a secure context (plain http on a LAN): the server skips the check
  const digest = await subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Identifies a file across app restarts without reading all of it: name, size, modification
 * time and a hash of its first and last MB.
 */
export async function fileFingerprint(file: Blob & { name?: string; lastModified?: number }) {
  const edge = 1024 * 1024;
  const head = await file.slice(0, Math.min(edge, file.size)).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - edge)).arrayBuffer();
  const label = new TextEncoder().encode(`${file.name ?? ""}|${file.size}|${file.lastModified ?? 0}|`);
  const joined = new Uint8Array(label.byteLength + head.byteLength + tail.byteLength);
  joined.set(label, 0);
  joined.set(new Uint8Array(head), label.byteLength);
  joined.set(new Uint8Array(tail), label.byteLength + head.byteLength);
  const hex = await sha256Hex(joined.buffer);
  if (hex) return `v1:${hex.slice(0, 40)}`;
  // No WebCrypto: a weaker but stable fingerprint.
  let hash = 2166136261;
  for (const byte of joined) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `v0:${file.size}:${file.lastModified ?? 0}:${hash.toString(16)}`;
}

/**
 * Send `file`; resolves with the new video's id once the server has started preparing it.
 * Rejects with UploadRefused (the server said no: too big, not a video, limit reached...) or
 * UploadCancelled. Never rejects because of a dropped connection: it waits and carries on.
 */
export async function sendInPieces(options: SendOptions): Promise<{ loopId: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const waitForConnection = options.waitForConnection ?? defaultWaitForConnection;
  const digest = options.sha256 ?? sha256Hex;
  const events = options.events ?? {};
  const signal = options.signal;
  const firstDelay = options.retryDelayMs ?? 2000;
  const maxDelay = options.maxRetryDelayMs ?? 30_000;
  let failures = 0;
  let restarts = 0;
  let waiting = false;

  const setWaiting = (value: boolean) => {
    if (waiting === value) return;
    waiting = value;
    events.onConnection?.(value ? "waiting" : "sending");
  };

  async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Outcome> {
    if (signal.aborted) throw new UploadCancelled();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        ...init,
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json", ...(init.headers ?? {}) },
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok) return { kind: "ok", status: response.status, body };
      if (response.status >= 500 || response.status === 408 || response.status === 429 && !body?.error) {
        return { kind: "retry", reason: `server ${response.status}`, status: response.status };
      }
      const message = typeof body?.error === "string" ? body.error : `The server refused the upload (${response.status}).`;
      return { kind: "refused", status: response.status, message, body };
    } catch {
      if (signal.aborted) throw new UploadCancelled();
      return { kind: "retry", reason: "no connection or no answer", status: 0 };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function backoff() {
    failures += 1;
    setWaiting(true);
    const delay = Math.min(maxDelay, firstDelay * 2 ** Math.min(failures - 1, 10));
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    // Offline: wake as soon as the phone says it's back (or after the delay anyway).
    await (offline ? waitForConnection(maxDelay, signal) : sleep(delay, signal));
  }

  function succeeded() {
    failures = 0;
    setWaiting(false);
  }

  /** Repeat `attempt` until it is not a "retry" outcome. */
  async function untilAnswered(attempt: () => Promise<Outcome>) {
    for (;;) {
      const outcome = await attempt();
      if (outcome.kind !== "retry") return outcome;
      await backoff();
    }
  }

  const openBody = JSON.stringify({
    name: options.name,
    fileName: options.fileName,
    size: options.file.size,
    fingerprint: options.fingerprint,
    target: options.target,
  });

  for (;;) {
    // 1. Open (or reopen) the upload.
    const opened = await untilAnswered(() =>
      call("/api/m/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: openBody }, CONTROL_TIMEOUT_MS),
    );
    if (opened.kind === "refused") throw new UploadRefused(opened.message, opened.status);
    succeeded();
    const session = opened.body as unknown as OpenAnswer;
    events.onSession?.(session);
    const received = new Set(session.received);
    let confirmedBytes = session.receivedBytes;
    let lost = false;

    // 2. Send the pieces the server does not have yet, one at a time.
    for (let index = 0; index < session.pieceCount && !lost; index += 1) {
      if (received.has(index)) continue;
      const start = index * session.pieceBytes;
      const piece = options.file.slice(start, Math.min(options.file.size, start + session.pieceBytes));
      const bytes = await piece.arrayBuffer();
      const hash = await digest(bytes);
      for (;;) {
        const outcome = await call(
          `/api/m/uploads/${session.uploadId}/pieces/${index}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", ...(hash ? { "X-Piece-Sha256": hash } : {}) },
            body: bytes,
          },
          PIECE_TIMEOUT_MS,
        );
        if (outcome.kind === "ok") {
          succeeded();
          received.add(index);
          confirmedBytes += bytes.byteLength;
          events.onProgress?.({ confirmedBytes, piecesDone: received.size, pieceCount: session.pieceCount });
          break;
        }
        if (outcome.kind === "refused") {
          if (outcome.status === 404) {
            lost = true; // the server no longer has this upload
            break;
          }
          if (outcome.status === 409) break; // already complete: go and finish
          if (outcome.status === 400 && /damaged/.test(outcome.message)) {
            await backoff();
            continue;
          }
          throw new UploadRefused(outcome.message, outcome.status);
        }
        await backoff();
      }
    }

    // 3. Join and hand over.
    if (!lost) {
      events.onFinishing?.();
      for (;;) {
        const finished = await untilAnswered(() => call(`/api/m/uploads/${session.uploadId}/complete`, { method: "POST" }, COMPLETE_TIMEOUT_MS));
        if (finished.kind === "ok") {
          succeeded();
          return { loopId: String(finished.body?.loopId) };
        }
        if (finished.status === 404) {
          lost = true;
          break;
        }
        if (finished.status === 409 && finished.body && Array.isArray((finished.body as { details?: { received?: unknown } }).details?.received)) {
          break; // pieces missing after all: reopen to see which, and send them
        }
        throw new UploadRefused(finished.message, finished.status);
      }
      if (!lost) continue;
    }

    // The server lost the upload: start this file again from the beginning.
    restarts += 1;
    if (restarts > MAX_RESTARTS) {
      throw new UploadRefused("The server kept losing this upload. Please try again later.", 404);
    }
    events.onRestart?.(restarts);
  }
}
