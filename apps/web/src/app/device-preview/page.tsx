import type { Metadata, Viewport } from "next";

import { DevicePreviewPlayer } from "@/components/device-preview-player";
import { getCurrentPublishedLoop } from "@/lib/fleet-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Screen preview",
  description: "Full-screen preview of the loop all cabs play.",
  appleWebApp: {
    capable: true,
    title: "Orison screen preview",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default async function DevicePreviewPage() {
  const loop = await getCurrentPublishedLoop();

  if (!loop?.compiledVideoUrl) {
    return (
      <main className="device-preview-screen">
        <div className="device-preview-overlay" role="status">
          <strong>No published loop available</strong>
          <span>No loop is on air for all cabs yet. Put one on air to preview it here.</span>
        </div>
      </main>
    );
  }

  return (
    <DevicePreviewPlayer
      loopName={loop.name}
      safetyMedia={loop.safetyVideo ?? null}
      videoUrl={loop.compiledVideoUrl}
    />
  );
}
