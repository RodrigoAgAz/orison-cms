"use client";

import { useEffect, useState } from "react";

type DevicePreviewPlayerProps = {
  loopName: string;
  videoUrl: string;
  safetyMedia?: {
    url: string;
    durationMs: number;
    mimeType: string;
  } | null;
};

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function DevicePreviewPlayer({ loopName, videoUrl, safetyMedia }: DevicePreviewPlayerProps) {
  const [phase, setPhase] = useState<"safety" | "loop">(safetyMedia ? "safety" : "loop");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    setPhase(safetyMedia ? "safety" : "loop");
    setStatus("loading");
  }, [safetyMedia, videoUrl]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      window.location.reload();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (
      phase !== "safety" ||
      !safetyMedia ||
      !safetyMedia.mimeType.startsWith("image/") ||
      status !== "ready"
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setStatus("loading");
      setPhase("loop");
    }, safetyMedia.durationMs);

    return () => window.clearTimeout(timer);
  }, [phase, safetyMedia, status]);

  function loadingLabel() {
    if (phase === "safety" && safetyMedia) {
      return "Loading safety message...";
    }

    return "Loading current published loop...";
  }

  function handleSafetyError() {
    setStatus("loading");
    setPhase("loop");
  }

  return (
    <main className="device-preview-screen">
      {status !== "ready" ? (
        <div className="device-preview-overlay" role="status">
          <strong>{status === "loading" ? loadingLabel() : "Unable to load published loop video."}</strong>
          {status === "error" ? <span>Check the published loop and safety asset URLs, then try again.</span> : null}
        </div>
      ) : null}

      {phase === "safety" && safetyMedia ? (
        safetyMedia.mimeType.startsWith("image/") ? (
          <img
            alt={`${loopName} safety message`}
            className="device-preview-video"
            onError={handleSafetyError}
            onLoad={() => setStatus("ready")}
            src={safetyMedia.url}
          />
        ) : (
          <video
            aria-label={`${loopName} safety message`}
            autoPlay
            className="device-preview-video"
            muted
            onCanPlay={() => setStatus("ready")}
            onEnded={() => {
              setStatus("loading");
              setPhase("loop");
            }}
            onError={handleSafetyError}
            playsInline
            preload="auto"
            src={safetyMedia.url}
          />
        )
      ) : (
        <video
          aria-label={`${loopName} preview`}
          autoPlay
          className="device-preview-video"
          loop
          muted
          onCanPlay={() => setStatus("ready")}
          onError={() => setStatus("error")}
          playsInline
          preload="auto"
          src={videoUrl}
        />
      )}
    </main>
  );
}
