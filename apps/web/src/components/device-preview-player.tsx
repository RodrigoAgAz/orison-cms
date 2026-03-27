"use client";

import { useEffect, useRef, useState } from "react";

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
  const loopVideoRef = useRef<HTMLVideoElement | null>(null);
  const [activeSurface, setActiveSurface] = useState<"safety" | "loop">(safetyMedia ? "safety" : "loop");
  const [safetyReady, setSafetyReady] = useState(!safetyMedia);
  const [loopReady, setLoopReady] = useState(false);
  const [shouldEnterLoop, setShouldEnterLoop] = useState(!safetyMedia);
  const [status, setStatus] = useState<"loading" | "error">("loading");

  useEffect(() => {
    setActiveSurface(safetyMedia ? "safety" : "loop");
    setSafetyReady(!safetyMedia);
    setLoopReady(false);
    setShouldEnterLoop(!safetyMedia);
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
      activeSurface !== "safety" ||
      !safetyMedia ||
      !safetyMedia.mimeType.startsWith("image/") ||
      !safetyReady
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setShouldEnterLoop(true);
    }, safetyMedia.durationMs);

    return () => window.clearTimeout(timer);
  }, [activeSurface, safetyMedia, safetyReady]);

  useEffect(() => {
    if (activeSurface !== "safety") {
      return;
    }

    loopVideoRef.current?.load();
  }, [activeSurface, videoUrl]);

  useEffect(() => {
    if (!shouldEnterLoop || !loopReady) {
      return;
    }

    setActiveSurface("loop");
    setStatus("loading");

    const playPromise = loopVideoRef.current?.play();
    void playPromise?.catch(() => {
      setStatus("error");
    });
  }, [loopReady, shouldEnterLoop]);

  function loadingLabel() {
    if (activeSurface === "safety" && safetyMedia && !safetyReady) {
      return "Loading safety message...";
    }

    return "Loading current published loop...";
  }

  function handleSafetyError() {
    setShouldEnterLoop(true);
    setActiveSurface("loop");

    if (loopReady) {
      const playPromise = loopVideoRef.current?.play();
      void playPromise?.catch(() => {
        setStatus("error");
      });
      return;
    }

    setStatus("loading");
  }

  const showOverlay =
    status === "error" || (activeSurface === "safety" ? !safetyReady : !loopReady);

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
        autoPlay={!safetyMedia}
        className="device-preview-video"
        loop
        muted
        onCanPlay={() => {
          setLoopReady(true);
          if (activeSurface === "loop") {
            setStatus("loading");
          }
        }}
        onError={() => setStatus("error")}
        playsInline
        preload="auto"
        ref={loopVideoRef}
        src={videoUrl}
        style={activeSurface === "loop" ? visibleSurfaceStyle : hiddenSurfaceStyle}
      />

      {activeSurface === "safety" && safetyMedia ? (
        safetyMedia.mimeType.startsWith("image/") ? (
          <img
            alt={`${loopName} safety message`}
            className="device-preview-video"
            onError={handleSafetyError}
            onLoad={() => {
              setSafetyReady(true);
              setStatus("loading");
            }}
            src={safetyMedia.url}
            style={visibleSurfaceStyle}
          />
        ) : (
          <video
            aria-label={`${loopName} safety message`}
            autoPlay
            className="device-preview-video"
            muted
            onCanPlay={() => {
              setSafetyReady(true);
              setStatus("loading");
            }}
            onEnded={() => {
              setShouldEnterLoop(true);
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
