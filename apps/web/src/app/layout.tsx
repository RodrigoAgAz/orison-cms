import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { ToastProvider } from "@/components/toast-provider";
import { getSessionUser } from "@/lib/auth";

import "./globals.css";

export const metadata: Metadata = {
  title: "Orison Screens CMS",
  description: "Digital signage control plane for the Orison pilot fleet.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getSessionUser();

  return (
    <html lang="en">
      <body>
        <ToastProvider>
          {user ? (
            <AppShell user={{ name: user.name, role: user.role }}>
              {children}
            </AppShell>
          ) : (
            children
          )}
        </ToastProvider>
      </body>
    </html>
  );
}
