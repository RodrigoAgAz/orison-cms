import type { Metadata } from "next";
import { headers } from "next/headers";

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
  const pathname = headers().get("x-orison-pathname") ?? "";
  const isDevicePreview = pathname.startsWith("/device-preview");
  const user = await getSessionUser();

  return (
    <html lang="en">
      <body className={isDevicePreview ? "device-preview-body" : undefined}>
        {isDevicePreview ? (
          children
        ) : (
          <ToastProvider>
            {user ? (
              <AppShell user={{ name: user.name, role: user.role }}>
                {children}
              </AppShell>
            ) : (
              children
            )}
          </ToastProvider>
        )}
      </body>
    </html>
  );
}
