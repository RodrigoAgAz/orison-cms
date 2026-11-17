"use client";

// Upload manager. Lives in the app shell so an upload keeps going while the user moves between
// screens. The file goes up in pieces of a few MB (lib/piece-sender.ts): the hosting proxy cuts
// off any request whose body takes more than 5 minutes, so one long request can't carry a video
// over a phone connection. A dropped connection only pauses the upload; it carries on by itself.
// Once the server has every piece it prepares the video on its own and we poll it until it is
// ready or has failed. The job is remembered in localStorage: a video still being prepared
// reappears after the app is reopened, and an upload that was cut short asks for the same file
// again and carries on from the pieces the server already has.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiFailure, sendToLogin } from "./api";
import { fileFingerprint, sendInPieces, UploadCancelled, UploadRefused } from "./piece-sender";
import { invalidate } from "./store";
import type { AssignTarget, LoopSummary } from "./types";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_SECONDS = 14 * 60;
export const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".m4v"];

export type UploadPhase = "uploading" | "processing" | "ready" | "failed";

export type UploadJob = {
  key: string;
  name: string;
  fileName: string;
  size: number;
  target: AssignTarget | null;
  targetLabel: string | null;
  phase: UploadPhase;
  /** Bytes the server has confirmed. */
  loaded: number;
  startedAt: number;
  rate: number | null; // bytes per second, from confirmed pieces
  loopId: string | null;
  error: string | null;
  /** Ready, but the server could not put it where it was asked to go. */
  warning: string | null;
  /** Length of the video in seconds, read on the phone before sending (for honest waiting times). */
  seconds?: number | null;
  loop: LoopSummary | null;
  /** The server's id for this upload, and the file's fingerprint (to carry on with the same file). */
  uploadId?: string | null;
  fingerprint?: string | null;
  lastModified?: number | null;
  piecesDone?: number;
  pieceCount?: number;
  /** No connection (or no answer): waiting to carry on by itself. */
  waitingForConnection?: boolean;
  /** The server lost the upload (restart) and it started again from the beginning. */
  restarted?: number;
  /** The app was reopened mid-upload: the same file must be chosen again to carry on. */
  needsFile?: boolean;
  /** Joining the pieces at the server. */
  finishing?: boolean;
};

export type StartInput = {
  file: File;
  name: string;
  target: AssignTarget | null;
  targetLabel: string | null;
  seconds?: number | null;
};

type UploadContextValue = {
  job: UploadJob | null;
  start: (input: StartInput) => void;
  /** Carry on an interrupted upload with the file chosen again; false if it isn't the same file. */
  resumeWith: (file: File) => Promise<boolean>;
  cancel: () => void;
  dismiss: () => void;
};

const UploadContext = createContext<UploadContextValue | null>(null);
const STORAGE_KEY = "orison.mobile.upload";

function remember(job: UploadJob | null) {
  try {
    if (job && ((job.phase === "processing" && job.loopId) || (job.phase === "uploading" && job.fingerprint))) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...job, loop: null }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage unavailable (private mode); the library still shows the item from the server
  }
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<UploadJob | null>(null);
  const sendRef = useRef<AbortController | null>(null);
  const pollRef = useRef<number | null>(null);
  // Bumped whenever polling starts or a new upload begins: a check still in flight for an earlier
  // video must not write its answer onto the current one.
  const pollTokenRef = useRef(0);
  const jobRef = useRef<UploadJob | null>(null);
  jobRef.current = job;

  const update = useCallback((patch: Partial<UploadJob> | ((job: UploadJob) => Partial<UploadJob>), key?: string) => {
    setJob((current) => {
      if (!current || (key && current.key !== key)) return current;
      const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
      remember(next);
      return next;
    });
  }, []);

  const poll = useCallback(
    (loopId: string) => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      const token = ++pollTokenRef.current;
      // Preparing takes minutes for a long video: check every 5 s at first, then less often. While
      // the app is in the background nothing is checked; coming back checks at once.
      let checks = 0;
      const next = (tick: () => void, delay: number) => {
        pollRef.current = window.setTimeout(() => {
          if (document.visibilityState === "hidden") {
            pollRef.current = null;
            return;
          }
          tick();
        }, delay);
      };
      const tick = async () => {
        checks += 1;
        try {
          const loop = await api<LoopSummary>(`/api/m/loops/${loopId}`);
          if (token !== pollTokenRef.current) return;
          if (loop.processing.state === "processing") {
            update({ loop });
            next(tick, checks < 12 ? 5000 : 15_000);
            return;
          }
          if (loop.processing.state === "failed") {
            update({ phase: "failed", loop, error: loop.processing.error ?? "The video couldn't be prepared." });
          } else {
            update({ phase: "ready", loop, warning: loop.processing.error });
          }
          pollRef.current = null;
          void invalidate("/api/m/");
        } catch (error) {
          if (token !== pollTokenRef.current) return;
          if (error instanceof ApiFailure && error.status === 404) {
            update({ phase: "failed", error: "This upload was removed." });
            return;
          }
          // network blip or no answer: keep trying, a little slower
          next(tick, 10_000);
        }
      };
      void tick();
    },
    [update],
  );

  // Resume a job that was being prepared, or was cut short while sending, when the app was closed.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const restored = JSON.parse(saved) as UploadJob;
        if (restored.phase === "processing" && restored.loopId) {
          setJob({ ...restored, loop: null });
          poll(restored.loopId);
        } else if (restored.phase === "uploading" && restored.fingerprint) {
          // The file itself is gone with the page: ask for it again.
          setJob({ ...restored, loop: null, needsFile: true, waitingForConnection: false, finishing: false, rate: null });
        }
      }
    } catch {
      // ignore
    }
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [poll]);

  // Pick up where we left off when the app returns to the foreground.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && job?.phase === "processing" && job.loopId) poll(job.loopId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [job?.phase, job?.loopId, poll]);

  const run = useCallback(
    async (input: StartInput, fingerprint: string, previous?: UploadJob) => {
      sendRef.current?.abort();
      // An earlier video still being prepared carries on at the server (it stays in Videos);
      // this screen follows the new one from now on.
      if (pollRef.current) window.clearTimeout(pollRef.current);
      pollRef.current = null;
      pollTokenRef.current += 1;
      const controller = new AbortController();
      sendRef.current = controller;
      const key = `${Date.now()}`;
      const startedAt = Date.now();
      const fresh: UploadJob = {
        key,
        name: input.name,
        fileName: input.file.name,
        size: input.file.size,
        target: input.target,
        targetLabel: input.targetLabel,
        phase: "uploading",
        loaded: previous?.loaded ?? 0,
        startedAt: previous?.startedAt ?? startedAt,
        rate: null,
        loopId: null,
        error: null,
        warning: null,
        loop: null,
        seconds: input.seconds ?? previous?.seconds ?? null,
        fingerprint,
        lastModified: input.file.lastModified,
        uploadId: previous?.uploadId ?? null,
        piecesDone: previous?.piecesDone,
        pieceCount: previous?.pieceCount,
        restarted: 0,
      };
      setJob(fresh);
      remember(fresh);
      let firstConfirmed: { bytes: number; at: number } | null = null;
      try {
        const { loopId } = await sendInPieces({
          file: input.file,
          fileName: input.file.name || "video.mov",
          name: input.name,
          target: input.target,
          fingerprint,
          signal: controller.signal,
          events: {
            onSession: (session) => {
              firstConfirmed = { bytes: session.receivedBytes, at: Date.now() };
              update(
                {
                  uploadId: session.uploadId,
                  loaded: session.receivedBytes,
                  piecesDone: session.received.length,
                  pieceCount: session.pieceCount,
                },
                key,
              );
            },
            onProgress: ({ confirmedBytes, piecesDone, pieceCount }) => {
              const base = firstConfirmed ?? { bytes: 0, at: startedAt };
              const elapsed = (Date.now() - base.at) / 1000;
              update(
                {
                  loaded: confirmedBytes,
                  piecesDone,
                  pieceCount,
                  rate: elapsed > 1 ? (confirmedBytes - base.bytes) / elapsed : null,
                  waitingForConnection: false,
                },
                key,
              );
            },
            onConnection: (state) => update({ waitingForConnection: state === "waiting" }, key),
            onRestart: (count) => {
              firstConfirmed = null;
              update({ restarted: count, loaded: 0, piecesDone: 0, rate: null, waitingForConnection: false }, key);
            },
            onFinishing: () => update({ finishing: true, loaded: input.file.size }, key),
          },
        });
        if (controller.signal.aborted) return;
        update({ phase: "processing", loaded: input.file.size, loopId, finishing: false, waitingForConnection: false }, key);
        void invalidate("/api/m/loops");
        poll(loopId);
      } catch (error) {
        if (error instanceof UploadCancelled || controller.signal.aborted) return;
        if (error instanceof UploadRefused && error.status === 401) {
          sendToLogin();
          return;
        }
        update(
          {
            phase: "failed",
            finishing: false,
            waitingForConnection: false,
            error:
              error instanceof UploadRefused
                ? error.message
                : "Something went wrong while sending the video. Please try again.",
          },
          key,
        );
      } finally {
        if (sendRef.current === controller) sendRef.current = null;
      }
    },
    [poll, update],
  );

  const start = useCallback<UploadContextValue["start"]>(
    (input) => {
      void (async () => {
        let fingerprint: string;
        try {
          fingerprint = await fileFingerprint(input.file);
        } catch {
          fingerprint = `v0:${input.file.size}:${input.file.lastModified}:${encodeURIComponent(input.file.name).slice(0, 80)}`;
        }
        await run(input, fingerprint);
      })();
    },
    [run],
  );

  const resumeWith = useCallback(
    async (file: File) => {
      const current = jobRef.current;
      if (!current || !current.fingerprint) return false;
      const fingerprint = await fileFingerprint(file).catch(() => null);
      if (!fingerprint || fingerprint !== current.fingerprint || file.size !== current.size) return false;
      void run(
        { file, name: current.name, target: current.target, targetLabel: current.targetLabel, seconds: current.seconds },
        fingerprint,
        current,
      );
      return true;
    },
    [run],
  );

  const cancel = useCallback(() => {
    sendRef.current?.abort();
    sendRef.current = null;
    const uploadId = jobRef.current?.uploadId;
    if (uploadId) {
      // Free the pieces at the server (if this fails they are cleaned up after a day).
      void api(`/api/m/uploads/${uploadId}`, { method: "DELETE" }).catch(() => undefined);
    }
    setJob(null);
    remember(null);
  }, []);

  const dismiss = useCallback(() => {
    sendRef.current?.abort();
    sendRef.current = null;
    pollTokenRef.current += 1;
    if (pollRef.current) window.clearTimeout(pollRef.current);
    setJob(null);
    remember(null);
  }, []);

  // Warn before closing the page while pieces are still being sent.
  useEffect(() => {
    if (job?.phase !== "uploading" || job.needsFile) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [job?.phase, job?.needsFile]);

  const value = useMemo(() => ({ job, start, resumeWith, cancel, dismiss }), [job, start, resumeWith, cancel, dismiss]);
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUpload() {
  const value = useContext(UploadContext);
  if (!value) throw new Error("useUpload must be used inside UploadProvider");
  return value;
}

export function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 8000);
    video.src = url;
  });
}
