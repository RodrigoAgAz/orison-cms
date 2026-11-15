import type { Metadata } from "next";

import { PasswordScreen } from "@/mobile/screens/password";

export const metadata: Metadata = { title: "Change password" };

export default function Page() {
  return <PasswordScreen />;
}
