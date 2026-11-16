"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";

import { useResource } from "../lib/store";
import type { SessionUser } from "../lib/types";
import { UploadProvider, useUpload } from "../lib/upload";
import { CabsIcon, CheckIcon, CloseIcon, MapIcon, PersonIcon, UploadIcon, VideosIcon, AlertIcon } from "./icons";
import { NavDepthProvider } from "./nav-depth";
import { href, Spinner } from "./ui";

const tabs = [
  { to: "/m", label: "Cabs", icon: CabsIcon, match: (p: string) => p === "/m" || p.startsWith("/m/cabs") || p.startsWith("/m/change") },
  { to: "/m/map", label: "Map", icon: MapIcon, match: (p: string) => p.startsWith("/m/map") },
  { to: "/m/videos", label: "Videos", icon: VideosIcon, match: (p: string) => p.startsWith("/m/videos") },
  { to: "/m/upload", label: "Upload", icon: UploadIcon, match: (p: string) => p.startsWith("/m/upload") },
  { to: "/m/account", label: "Account", icon: PersonIcon, match: (p: string) => p.startsWith("/m/account") },
];

const SessionContext = createContext<SessionUser | undefined>(undefined);

export function useSessionUser() {
  return useContext(SessionContext);
}

export function MobileShell({ children }: { children: React.ReactNode }) {
  // Renews the 30-day session on every app start (sliding expiry) and tells us who is signed in.
  const me = useResource<SessionUser>("/api/auth/me", { refreshMs: 0 });
  return (
    <SessionContext.Provider value={me.data}>
      <NavDepthProvider>
        <UploadProvider>
          <div className="m-app">
            <main className="m-main">{children}</main>
            <UploadPill />
            <TabBar />
          </div>
        </UploadProvider>
      </NavDepthProvider>
    </SessionContext.Provider>
  );
}

function TabBar() {
  const pathname = usePathname();
  const { job } = useUpload();
  return (
    <nav className="m-tabbar" aria-label="Main">
      {tabs.map((tab) => {
        const active = tab.match(pathname);
        const Icon = tab.icon;
        const busy = tab.to === "/m/upload" && (job?.phase === "uploading" || job?.phase === "processing");
        return (
          <Link
            key={tab.to}
            href={href(tab.to)}
            className={`m-tab ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="m-tab-icon">
              <Icon size={24} strokeWidth={active ? 2.3 : 1.9} />
              {busy ? <span className="m-tab-dot" aria-label="Upload in progress" /> : null}
            </span>
            <span className="m-tab-label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function UploadPill() {
  const pathname = usePathname();
  const { job, dismiss } = useUpload();
  if (!job || pathname.startsWith("/m/upload")) return null;
  const percent = job.size ? Math.min(100, Math.round((job.loaded / job.size) * 100)) : 0;
  let text: React.ReactNode;
  let icon: React.ReactNode;
  if (job.phase === "uploading") {
    icon = <Spinner size={16} />;
    text = (
      <>
        Uploading <strong>{job.name}</strong> · {percent}%
      </>
    );
  } else if (job.phase === "processing") {
    icon = <Spinner size={16} />;
    text = (
      <>
        Getting <strong>{job.name}</strong> ready…
      </>
    );
  } else if (job.phase === "ready") {
    icon = <CheckIcon size={16} />;
    text = (
      <>
        <strong>{job.name}</strong> is ready
      </>
    );
  } else {
    icon = <AlertIcon size={16} />;
    text = (
      <>
        {job.uncertain ? (
          <>
            Not sure <strong>{job.name}</strong> arrived
          </>
        ) : (
          <>
            <strong>{job.name}</strong> didn&rsquo;t upload
          </>
        )}
      </>
    );
  }
  return (
    <div className={`m-pill m-pill-${job.phase}`} role="status" data-testid="upload-pill">
      <Link href={href("/m/upload")} className="m-pill-main">
        <span className="m-pill-icon">{icon}</span>
        <span className="m-pill-text">{text}</span>
        {job.phase === "uploading" ? (
          <span className="m-pill-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
        ) : null}
      </Link>
      {job.phase === "ready" || job.phase === "failed" ? (
        <button type="button" className="m-iconbtn m-pill-close" onClick={dismiss} aria-label="Dismiss">
          <CloseIcon size={16} />
        </button>
      ) : null}
    </div>
  );
}
