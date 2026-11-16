import type { Metadata, Viewport } from "next";

import "./mobile.css";

// The phone app. The root layout skips the desktop shell for /m (see src/app/layout.tsx).
export const metadata: Metadata = {
  title: { default: "Orison", template: "%s · Orison" },
  description: "See and change what plays on the Orison cab screens.",
  applicationName: "Orison",
  manifest: "/m-app/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Orison", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: [
      { url: "/m-app/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/m-app/favicon-64.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/m-app/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: { "mobile-web-app-capable": "yes" },
  // Open to anyone with the address by default (no sign-in), so keep it out of search engines.
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b1220",
  colorScheme: "dark",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
