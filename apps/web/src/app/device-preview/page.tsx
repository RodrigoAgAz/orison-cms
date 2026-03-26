import type { Metadata, Viewport } from "next";

import { DevicePreviewPlayer } from "@/components/device-preview-player";
import { getCurrentPublishedLoop } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Device Preview",
  description: "Fullscreen published loop preview for Orison device demos.",
  appleWebApp: {
    capable: true,
    title: "Orison Device Preview",
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
          <span>Publish a loop to preview the current fleet programme.</span>
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
