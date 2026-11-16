import type { Metadata } from "next";

import { MapScreen } from "@/mobile/screens/map";

export const metadata: Metadata = { title: "Map" };

export default function Page() {
  return <MapScreen />;
}
