import type { Metadata } from "next";

import { VideoScreen } from "@/mobile/screens/video";

export const metadata: Metadata = { title: "Video" };

export default function Page({ params }: { params: { id: string } }) {
  return <VideoScreen id={params.id} />;
}
