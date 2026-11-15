import type { Metadata } from "next";

import { TeamScreen } from "@/mobile/screens/team";

export const metadata: Metadata = { title: "Team" };

export default function Page() {
  return <TeamScreen />;
}
