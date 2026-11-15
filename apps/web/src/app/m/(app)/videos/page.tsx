import type { Metadata } from "next";

import { VideosScreen } from "@/mobile/screens/videos";

export const metadata: Metadata = { title: "Videos" };

export default function Page() {
  return <VideosScreen />;
}
