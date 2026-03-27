"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  const hasSafetyMedia = Boolean(safetyMedia);
  const loopVideoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<"safety" | "loop">(hasSafetyMedia ? "safety" : "loop");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showSafetyCover, setShowSafetyCover] = useState(hasSafetyMedia);
  const [loopReady, setLoopReady] = useState(false);
  const safetyIsImage = useMemo(
    () => Boolean(safetyMedia?.mimeType.startsWith("image/")),
    [safetyMedia?.mimeType],
  );

  useEffect(() => {
    setPhase(hasSafetyMedia ? "safety" : "loop");
    setStatus("loading");
    setShowSafetyCover(hasSafetyMedia);
    setLoopReady(false);
  }, [hasSafetyMedia, safetyMedia, videoUrl]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      window.location.reload();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (phase !== "safety" || !safetyMedia || !safetyIsImage || status !== "ready") {
      return;
    }

    const timer = window.setTimeout(() => {
      setStatus("loading");
      setPhase("loop");
    }, safetyMedia.durationMs);

    return () => window.clearTimeout(timer);
  }, [phase, safetyIsImage, safetyMedia, status]);

  useEffect(() => {
    if (phase !== "loop" || !loopReady) {
      return;
    }

    const video = loopVideoRef.current;
    if (!video) {
      return;
    }

    if (video.currentTime !== 0) {
      video.currentTime = 0;
    }

    const playPromise = video.play();
    void playPromise?.catch(() => {
      setStatus("error");
    });

    setShowSafetyCover(false);
    setStatus("ready");
  }, [loopReady, phase]);

  function loadingLabel() {
    if (phase === "safety" && safetyMedia) {
      return "Loading safety message...";
    }

    return "Loading current published loop...";
  }

  function handleSafetyError() {
    setShowSafetyCover(false);
    setStatus("loading");
    setPhase("loop");
  }

  const showOverlay =
    status === "error" ||
    (phase === "safety" ? status !== "ready" && !showSafetyCover : !loopReady && !showSafetyCover);

  const visibleSurfaceStyle = {
    position: "absolute" as const,
    inset: 0,
    opacity: 1,
  };

  const hiddenSurfaceStyle = {
    position: "absolute" as const,
    inset: 0,
    opacity: 0,
    pointerEvents: "none" as const,
  };

  return (
    <main className="device-preview-screen">
      {showOverlay ? (
        <div className="device-preview-overlay" role="status">
          <strong>{status === "loading" ? loadingLabel() : "Unable to load published loop video."}</strong>
          {status === "error" ? <span>Check the published loop and safety asset URLs, then try again.</span> : null}
        </div>
      ) : null}

      <video
        aria-label={`${loopName} preview`}
        autoPlay={!hasSafetyMedia}
        className="device-preview-video"
        loop
        muted
        onCanPlay={() => {
          setLoopReady(true);
          if (!hasSafetyMedia || phase === "loop") {
            setStatus("ready");
          }
        }}
        onError={() => {
          setShowSafetyCover(false);
          setStatus("error");
        }}
        playsInline
        preload="auto"
        ref={loopVideoRef}
        src={videoUrl}
        style={showSafetyCover ? hiddenSurfaceStyle : visibleSurfaceStyle}
      />

      {safetyMedia && showSafetyCover ? (
        safetyIsImage ? (
          <img
            alt={`${loopName} safety message`}
            className="device-preview-video"
            onError={handleSafetyError}
            onLoad={() => setStatus("ready")}
            src={safetyMedia.url}
            style={visibleSurfaceStyle}
          />
        ) : (
          <video
            aria-label={`${loopName} safety message`}
            autoPlay
            className="device-preview-video"
            muted
            onCanPlay={() => setStatus("ready")}
            onEnded={() => {
              setPhase("loop");
            }}
            onError={handleSafetyError}
            playsInline
            preload="auto"
            src={safetyMedia.url}
            style={visibleSurfaceStyle}
          />
        )
      ) : null}
    </main>
  );
}
