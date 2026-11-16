import type { Metadata } from "next";

import { HomeScreen } from "@/mobile/screens/home";

export const metadata: Metadata = { title: "Cabs" };

export default function Page() {
  return <HomeScreen />;
}
