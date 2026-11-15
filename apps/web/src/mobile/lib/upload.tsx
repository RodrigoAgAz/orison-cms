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
  loop: LoopSummary | null;
};

type UploadContextValue = {
  job: UploadJob | null;
  start: (input: { file: File; name: string; target: AssignTarget | null; targetLabel: string | null }) => void;
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
      const tick = async () => {
        try {
          const loop = await api<LoopSummary>(`/api/m/loops/${loopId}`);
          if (loop.processing.state === "processing") {
            update({ loop });
            pollRef.current = window.setTimeout(tick, 2500);
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
          if (error instanceof ApiFailure && error.status === 404) {
            update({ phase: "failed", error: "This upload was removed." });
            return;
          }
          // network blip: keep trying, a little slower
          pollRef.current = window.setTimeout(tick, 6000);
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
    ({ file, name, target, targetLabel }) => {
      xhrRef.current?.abort();
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
      };
      setJob(fresh);

      const params = new URLSearchParams({ name, filename: file.name || "video.mov" });
      if (target) params.set("target", JSON.stringify(target));
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", `/api/m/upload?${params.toString()}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = (event) => {
        const elapsed = (Date.now() - fresh.startedAt) / 1000;
        update({ loaded: event.loaded, rate: elapsed > 1 ? event.loaded / elapsed : null });
      };
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
            update({ phase: "failed", error: "The server didn't confirm the upload. Please try again." });
            return;
          }
          update({ phase: "processing", loaded: fresh.size, loopId });
          void invalidate("/api/m/loops");
          poll(loopId);
          return;
        }
        update({ phase: "failed", error: uploadErrorMessage(xhr.status, xhr.responseText) });
      };
      xhr.onerror = () => {
        xhrRef.current = null;
        update({
          phase: "failed",
          error: "The upload was interrupted, probably by a weak connection. Nothing was saved. Try again when you have a better signal or Wi-Fi.",
        });
      };
      xhr.onabort = () => {
        xhrRef.current = null;
      };
      xhr.send(file);
    },
    [poll, update],
  );

  const cancel = useCallback(() => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setJob(null);
    remember(null);
  }, []);

  const dismiss = useCallback(() => {
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
