import type { Metadata } from "next";

import { CabScreen } from "@/mobile/screens/cab";

export const metadata: Metadata = { title: "Cab" };

export default function Page({ params }: { params: { id: string } }) {
  return <CabScreen id={params.id} />;
}
