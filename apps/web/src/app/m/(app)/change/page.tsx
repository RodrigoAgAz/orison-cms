import type { Metadata } from "next";

import { ChangeScreen } from "@/mobile/screens/change";

export const metadata: Metadata = { title: "Change what plays" };

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value ?? null;
}

export default function Page({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  return <ChangeScreen initialLoop={first(searchParams.loop)} initialTarget={first(searchParams.target)} />;
}
