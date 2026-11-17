"use client";

// Upload manager. Lives in the app shell so an upload keeps going while the user moves between
// screens. The file is sent with XHR (for real progress); once the server has it, the server
// keeps processing on its own and we poll the video until it is ready or has failed. The
// in-progress job is remembered in localStorage so it reappears after the app is reopened.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiFailure, sendToLogin } from "./api";
import { invalidate } from "./store";
import type { AssignTarget, LoopSummary } from "./types";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_SECONDS = 14 * 60;
export const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".m4v"];
/**
 * The server stops a request whose body has not fully arrived within this long (REQUEST_TIMEOUT_SECONDS,
 * apps/web/scripts/server-timeouts.cjs). A proxy in front of it may be stricter.
 */
export const UPLOAD_TIME_LIMIT_SECONDS = 30 * 60;

export type UploadPhase = "uploading" | "processing" | "ready" | "failed";

export type UploadJob = {
  key: string;
  name: string;
  fileName: string;
  size: number;
  target: AssignTarget | null;
  targetLabel: string | null;
  phase: UploadPhase;
  loaded: number;
  startedAt: number;
  rate: number | null; // bytes per second
  loopId: string | null;
  error: string | null;
  /** Ready, but the server could not put it where it was asked to go. */
  warning: string | null;
  /** Failed phase only: we could not find out whether the server received the video. */
  uncertain?: boolean;
  /** Length of the video in seconds, read on the phone before sending (for honest waiting times). */
  seconds?: number | null;
  loop: LoopSummary | null;
};

type UploadContextValue = {
  job: UploadJob | null;
  start: (input: { file: File; name: string; target: AssignTarget | null; targetLabel: string | null; seconds?: number | null }) => void;
  cancel: () => void;
  dismiss: () => void;
};

const UploadContext = createContext<UploadContextValue | null>(null);
const STORAGE_KEY = "orison.mobile.upload";

function remember(job: UploadJob | null) {
  try {
    if (job && job.phase === "processing" && job.loopId) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...job, loop: null }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage unavailable (private mode); the library still shows the item from the server
  }
}

const UNCERTAIN_MESSAGE =
  "The connection dropped just as the video finished sending, so we can't tell whether it arrived. Look in Videos in a few minutes: if it's there, it's being prepared (and goes where you chose). If it isn't, upload it again.";
const INTERRUPTED_MESSAGE =
  "The upload was interrupted before the whole video was sent, probably by a weak connection or the phone locking. Nothing was saved. Try again with the app open, ideally on Wi-Fi.";

function uploadParams(job: Pick<UploadJob, "name" | "fileName" | "target">) {
  const params = new URLSearchParams({ name: job.name, filename: job.fileName || "video.mov" });
  if (job.target) params.set("target", JSON.stringify(job.target));
  return params.toString();
}

/** The upload's row if the server created one (matched by name, created after we started). */
async function findReceivedUpload(job: Pick<UploadJob, "name" | "startedAt">) {
  const { items } = await api<{ items: LoopSummary[] }>("/api/m/loops");
  return (
    items.find(
      (loop) =>
        loop.name === job.name && loop.source === "upload" && new Date(loop.createdAt).getTime() >= job.startedAt - 60_000,
    ) ?? null
  );
}

function uploadErrorMessage(status: number, body: string) {
  let message: string | null = null;
  try {
    message = (JSON.parse(body) as { error?: string }).error ?? null;
  } catch {
    message = null;
  }
  if (status === 413) return message ?? "This video is too big. Videos can be up to 500 MB.";
  if (status === 415) return message ?? "This file isn't a video we can use. Choose an MP4 or MOV video.";
  if (status >= 500) return "Something went wrong on our side while receiving the video. Please try again.";
  return message ?? "The upload didn't work. Please try again.";
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<UploadJob | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const pollRef = useRef<number | null>(null);
  // Bumped whenever polling starts or a new upload begins: a check still in flight for an earlier
  // video must not write its answer onto the current one.
  const pollTokenRef = useRef(0);
  // Key of the upload this provider is currently sending (null once cancelled or dismissed).
  const activeKeyRef = useRef<string | null>(null);

  const update = useCallback((patch: Partial<UploadJob> | ((job: UploadJob) => Partial<UploadJob>)) => {
    setJob((current) => {
      if (!current) return current;
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

  // Resume a job that was still being prepared when the app was closed.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const restored = JSON.parse(saved) as UploadJob;
        if (restored.loopId) {
          setJob({ ...restored, loop: null });
          poll(restored.loopId);
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

  const start = useCallback<UploadContextValue["start"]>(
    ({ file, name, target, targetLabel, seconds }) => {
      xhrRef.current?.abort();
      // An earlier video still being prepared carries on at the server (it stays in Videos);
      // this screen follows the new one from now on.
      if (pollRef.current) window.clearTimeout(pollRef.current);
      pollRef.current = null;
      pollTokenRef.current += 1;
      const fresh: UploadJob = {
        key: `${Date.now()}`,
        name,
        fileName: file.name,
        size: file.size,
        target,
        targetLabel,
        phase: "uploading",
        loaded: 0,
        startedAt: Date.now(),
        rate: null,
        loopId: null,
        error: null,
        warning: null,
        loop: null,
        seconds: seconds ?? null,
      };
      setJob(fresh);
      activeKeyRef.current = fresh.key;

      const query = uploadParams(fresh);
      const fail = (error: string, extra: Partial<UploadJob> = {}) => update({ phase: "failed", error, ...extra });

      // The send did not end with an answer we can read (connection dropped, proxy error, or the
      // server refused early while we were still sending). Find out what actually happened
      // instead of guessing.
      const settleUnknown = async (sentAll: boolean) => {
        try {
          const received = await findReceivedUpload(fresh);
          if (received) {
            update({ phase: "processing", loaded: fresh.size, loopId: received.id, loop: received });
            void invalidate("/api/m/loops");
            poll(received.id);
            return;
          }
        } catch {
          // offline: fall through
        }
        try {
          await api<{ ok: true }>(`/api/m/upload?${query}`);
        } catch (error) {
          if (error instanceof ApiFailure && !error.network && error.status !== 401) {
            fail(`The server didn't accept this upload: ${error.message}`);
            return;
          }
          if (error instanceof ApiFailure && error.status === 401) return; // sent to sign in
        }
        if (sentAll) {
          fail(UNCERTAIN_MESSAGE, { uncertain: true });
          // Keep looking for a few minutes: the server may still be receiving the last bytes.
          let tries = 0;
          const recheck = async () => {
            tries += 1;
            if (activeKeyRef.current !== fresh.key) return;
            const received = await findReceivedUpload(fresh).catch(() => null);
            if (received) {
              setJob((current) =>
                current && current.key === fresh.key && current.phase === "failed"
                  ? { ...current, phase: "processing", error: null, uncertain: false, loaded: fresh.size, loopId: received.id, loop: received }
                  : current,
              );
              void invalidate("/api/m/loops");
              poll(received.id);
            } else if (tries < 9) {
              window.setTimeout(() => void recheck(), 20_000);
            }
          };
          window.setTimeout(() => void recheck(), 20_000);
          return;
        }
        fail(INTERRUPTED_MESSAGE);
      };

      const send = () => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        let loaded = 0;
        xhr.open("POST", `/api/m/upload?${query}`);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.upload.onprogress = (event) => {
          loaded = event.loaded;
          const elapsed = (Date.now() - fresh.startedAt) / 1000;
          update({ loaded: event.loaded, rate: elapsed > 1 ? event.loaded / elapsed : null });
        };
        xhr.upload.onload = () => {
          loaded = fresh.size;
        };
        // Within 2% of the end, the last progress event may simply not have fired.
        const sentAll = () => loaded >= fresh.size * 0.98;
        xhr.onload = () => {
          xhrRef.current = null;
          if (xhr.status === 401) {
            sendToLogin();
            return;
          }
          if (xhr.status === 202 || xhr.status === 200) {
            let loopId: string | null = null;
            try {
              loopId = (JSON.parse(xhr.responseText) as { loopId?: string }).loopId ?? null;
            } catch {
              loopId = null;
            }
            if (!loopId) {
              void settleUnknown(true);
              return;
            }
            update({ phase: "processing", loaded: fresh.size, loopId });
            void invalidate("/api/m/loops");
            poll(loopId);
            return;
          }
          if (xhr.status === 0 || xhr.status >= 500) {
            // A proxy error or timeout: the server may have the video even though we got no answer.
            void settleUnknown(sentAll());
            return;
          }
          fail(uploadErrorMessage(xhr.status, xhr.responseText));
        };
        xhr.onerror = () => {
          xhrRef.current = null;
          void settleUnknown(sentAll());
        };
        xhr.onabort = () => {
          xhrRef.current = null;
        };
        xhr.send(file);
      };

      // Check the details first (signed in, name, target still exists) so a refusal is reported
      // as such rather than as a dropped connection half-way through sending.
      void api<{ ok: true }>(`/api/m/upload?${query}`)
        .then(() => {
          if (activeKeyRef.current === fresh.key) send();
        })
        .catch((error) => {
          if (error instanceof ApiFailure && error.status === 401) return;
          fail(
            error instanceof ApiFailure && error.network
              ? "No connection, so the upload didn't start. Nothing was sent. Try again when you have a signal."
              : `The upload didn't start: ${error instanceof Error ? error.message : "please try again"}`,
          );
        });
    },
    [poll, update],
  );

  const cancel = useCallback(() => {
    activeKeyRef.current = null;
    xhrRef.current?.abort();
    xhrRef.current = null;
    setJob(null);
    remember(null);
  }, []);

  const dismiss = useCallback(() => {
    activeKeyRef.current = null;
    pollTokenRef.current += 1;
    if (pollRef.current) window.clearTimeout(pollRef.current);
    setJob(null);
    remember(null);
  }, []);

  // Warn before closing the page while bytes are still being sent.
  useEffect(() => {
    if (job?.phase !== "uploading") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [job?.phase]);

  const value = useMemo(() => ({ job, start, cancel, dismiss }), [job, start, cancel, dismiss]);
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
