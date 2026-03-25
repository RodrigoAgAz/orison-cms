"use client";

import { useEffect, useState } from "react";

type DevicePreviewPlayerProps = {
  loopName: string;
  videoUrl: string;
};

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function DevicePreviewPlayer({ loopName, videoUrl }: DevicePreviewPlayerProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const timer = window.setInterval(() => {
      window.location.reload();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="device-preview-screen">
      {status !== "ready" ? (
        <div className="device-preview-overlay" role="status">
          <strong>
            {status === "loading" ? "Loading current published loop..." : "Unable to load published loop video."}
          </strong>
          {status === "error" ? <span>Check the published loop video URL and try again.</span> : null}
        </div>
      ) : null}
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
    </main>
  );
}
