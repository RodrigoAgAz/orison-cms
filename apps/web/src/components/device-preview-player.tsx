"use client";

import { useEffect } from "react";

type DevicePreviewPlayerProps = {
  loopName: string;
  videoUrl: string;
};

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function DevicePreviewPlayer({ loopName, videoUrl }: DevicePreviewPlayerProps) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      window.location.reload();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="device-preview-screen">
      <video
        aria-label={`${loopName} preview`}
        autoPlay
        className="device-preview-video"
        loop
        muted
        playsInline
        preload="auto"
        src={videoUrl}
      />
    </main>
  );
}
