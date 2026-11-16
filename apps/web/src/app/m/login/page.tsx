import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth";
import { LoginScreen } from "@/mobile/screens/login";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

function safeNext(value: string | string[] | undefined) {
  const next = Array.isArray(value) ? value[0] : value;
  // Only return to screens of the phone app (no open redirects).
  if (next && (next === "/m" || next.startsWith("/m/") || next.startsWith("/m?")) && !next.startsWith("/m/login")) {
    return next;
  }
  return "/m";
}

export default async function MobileLoginPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const next = safeNext(searchParams.next);
  if (await getSessionUser()) {
    redirect(next as never);
  }
  return <LoginScreen next={next} />;
}
