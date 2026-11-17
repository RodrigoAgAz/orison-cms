"use client";

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { clockTime, ago } from "../lib/format";
import { cabTone, toneWord, type Tone } from "../lib/status";
import type { CabSummary } from "../lib/types";
import { oldestVisibleUpdate, useConnection } from "../lib/store";
import { AlertIcon, BackIcon, CloseIcon, InfoIcon, OfflineIcon, PauseIcon, RefreshIcon, SwitchIcon, VideosIcon } from "./icons";
import { useNavDepth } from "./nav-depth";

export function href(path: string) {
  return path as Route;
}

// ---------------------------------------------------------------------------------------------
// Status: always colour + shape + word.

export function StatusShape({ tone, size = 12 }: { tone: Tone; size?: number }) {
  if (tone === "switching") {
    return (
      <span className="m-shape m-shape-switching" style={{ width: size + 2, height: size + 2 }} aria-hidden="true">
        <SwitchIcon size={size + 2} strokeWidth={2.6} />
      </span>
    );
  }
  if (tone === "paused") {
    return (
      <span className="m-shape m-shape-paused" style={{ width: size, height: size }} aria-hidden="true">
        <PauseIcon size={size} />
      </span>
    );
  }
  return <span className={`m-shape m-shape-${tone}`} style={{ width: size, height: size }} aria-hidden="true" />;
}

export function StatusBadge({ cab, size = "md" }: { cab: Pick<CabSummary, "status">; size?: "md" | "lg" }) {
  const tone = cabTone(cab);
  return (
    <span className={`m-status m-status-${tone} m-status-${size}`} data-status={cab.status}>
      <StatusShape tone={tone} size={size === "lg" ? 14 : 11} />
      <span>{toneWord[tone]}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------

export function Poster({
  src,
  alt,
  ratio = "wide",
  className,
}: {
  src: string | null | undefined;
  alt: string;
  ratio?: "wide" | "thumb" | "square";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`m-poster m-poster-${ratio} ${className ?? ""}`}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="m-poster-empty" role="img" aria-label={alt}>
          <VideosIcon size={ratio === "thumb" ? 18 : 28} />
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Screen chrome

export function BackButton({ fallback, label }: { fallback: string; label: string }) {
  const router = useRouter();
  const depth = useNavDepth();
  return (
    <button
      type="button"
      className="m-back"
      onClick={() => {
        if (depth > 1) router.back();
        else router.push(href(fallback));
      }}
    >
      <BackIcon size={22} />
      <span>{label}</span>
    </button>
  );
}

export function TopBar({
  title,
  back,
  right,
  large = false,
  subtitle,
}: {
  title: string;
  back?: { fallback: string; label: string };
  right?: React.ReactNode;
  large?: boolean;
  subtitle?: React.ReactNode;
}) {
  return (
    <header className={`m-topbar ${large ? "m-topbar-large" : ""}`}>
      <div className="m-topbar-row">
        <div className="m-topbar-left">{back ? <BackButton {...back} /> : null}</div>
        {!large ? <h1 className="m-topbar-title">{title}</h1> : <span />}
        <div className="m-topbar-right">{right}</div>
      </div>
      {large ? (
        <div className="m-topbar-largetitle">
          <h1>{title}</h1>
          {subtitle ? <div className="m-topbar-subtitle">{subtitle}</div> : null}
        </div>
      ) : null}
      <ConnectionNotice />
    </header>
  );
}

export function Freshness({
  updatedAt,
  loading,
  onRefresh,
}: {
  updatedAt: number | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const label = !updatedAt ? "Loading…" : Date.now() - updatedAt < 60_000 ? "Updated just now" : `Updated ${clockTime(updatedAt)}`;
  return (
    <button
      type="button"
      className={`m-fresh ${loading ? "is-loading" : ""}`}
      onClick={onRefresh}
      aria-label={`${label}. Refresh now`}
      data-testid="freshness"
    >
      <RefreshIcon size={14} strokeWidth={2.4} />
      <span>{label}</span>
    </button>
  );
}

export function ConnectionNotice() {
  const connection = useConnection();
  if (!connection.offline) return null;
  // The age of what is on screen, not when the connection dropped (which can be much later).
  const dataAt = oldestVisibleUpdate();
  return (
    <div className="m-offline" role="status" data-testid="offline-notice">
      <OfflineIcon size={16} />
      <span>
        {dataAt
          ? `No connection. Showing what we last heard at ${clockTime(dataAt)}${Date.now() - dataAt >= 60_000 ? ` (${ago(dataAt)})` : ""}; it refreshes when you’re back online.`
          : "No connection. This refreshes when you’re back online."}
      </span>
    </div>
  );
}

export function Screen({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`m-screen ${className ?? ""}`}>{children}</div>;
}

export function Section({
  title,
  action,
  children,
  id,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section className="m-section" aria-labelledby={title ? `${id ?? title}-h` : undefined}>
      {title ? (
        <div className="m-section-head">
          <h2 id={`${id ?? title}-h`}>{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// States

export function Skeleton({ lines = 3, card = true }: { lines?: number; card?: boolean }) {
  return (
    <div className={card ? "m-card m-skeleton-card" : "m-skeleton-card"} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="m-skeleton" style={{ width: `${88 - index * 17}%` }} />
      ))}
    </div>
  );
}

export function LoadingScreen({ label = "Loading" }: { label?: string }) {
  return (
    <div className="m-loading" role="status" aria-label={label}>
      <Skeleton lines={2} />
      <Skeleton lines={4} />
      <Skeleton lines={3} />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="m-state" role="alert">
      <span className="m-state-icon m-state-icon-warn">
        <AlertIcon size={26} />
      </span>
      <h2>Couldn&rsquo;t load this</h2>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="m-btn m-btn-secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="m-state">
      <span className="m-state-icon">{icon}</span>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  title,
  testId,
}: {
  tone?: "info" | "warn" | "danger" | "success";
  children: React.ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <div className={`m-notice m-notice-${tone}`} role={tone === "danger" ? "alert" : undefined} data-testid={testId}>
      <span className="m-notice-icon">{tone === "info" || tone === "success" ? <InfoIcon size={18} /> : <AlertIcon size={18} />}</span>
      <div>
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function ButtonLink({
  to,
  children,
  variant = "primary",
  className,
  testId,
}: {
  to: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  testId?: string;
}) {
  return (
    <Link href={href(to)} className={`m-btn m-btn-${variant} ${className ?? ""}`} data-testid={testId}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------------------------
// Bottom sheet (modal dialog)

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  testId,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
  dismissible?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("m-noscroll");
    window.setTimeout(() => panelRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("m-noscroll");
      previous?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;
  return (
    <div className="m-sheet-layer">
      <div className="m-sheet-backdrop" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        data-testid={testId}
      >
        <div className="m-sheet-grip" aria-hidden="true" />
        <div className="m-sheet-head">
          <h2 id={titleId}>{title}</h2>
          {dismissible ? (
            <button type="button" className="m-iconbtn" onClick={onClose} aria-label="Close">
              <CloseIcon size={20} />
            </button>
          ) : null}
        </div>
        <div className="m-sheet-body">{children}</div>
        {footer ? <div className="m-sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="m-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function KeyValue({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="m-kv">
      {items.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
