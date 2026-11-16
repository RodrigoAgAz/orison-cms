import type { Metadata } from "next";

import { UploadScreen } from "@/mobile/screens/upload";

export const metadata: Metadata = { title: "Upload" };

export default function Page({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const target = Array.isArray(searchParams.target) ? searchParams.target[0] : searchParams.target;
  return <UploadScreen initialTarget={target ?? null} />;
}
