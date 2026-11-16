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
  // The phone app at /m brings its own shell, stylesheet and metadata (src/app/m/layout.tsx).
  const isMobileApp = pathname === "/m" || pathname.startsWith("/m/");
  if (isMobileApp) {
    return (
      <html lang="en-GB">
        <body className="m-body">{children}</body>
      </html>
    );
  }
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
