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
  const publishedLoop = await getCurrentPublishedLoop();

  if (!publishedLoop?.compiledVideoUrl) {
    return (
      <main className="device-preview-screen device-preview-empty" role="status">
        <span>No published loop available.</span>
      </main>
    );
  }

  return (
    <DevicePreviewPlayer
      loopName={publishedLoop.name}
      videoUrl={`${publishedLoop.compiledVideoUrl}?v=${encodeURIComponent(
        publishedLoop.checksum ?? publishedLoop.updatedAt.toISOString(),
      )}`}
    />
  );
}
