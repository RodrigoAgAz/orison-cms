"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  user: {
    name: string;
    role: string;
  };
  children: React.ReactNode;
};

// Simple line icons (24px grid, drawn with currentColor) instead of two-letter stand-ins.
const icons = {
  dashboard: (
    <>
      <rect height="8" rx="1.5" width="8" x="3" y="3" />
      <rect height="5" rx="1.5" width="8" x="13" y="3" />
      <rect height="8" rx="1.5" width="8" x="13" y="13" />
      <rect height="5" rx="1.5" width="8" x="3" y="16" />
    </>
  ),
  loops: (
    <>
      <path d="M17 2l3 3-3 3" />
      <path d="M4 11V9a4 4 0 0 1 4-4h12" />
      <path d="M7 22l-3-3 3-3" />
      <path d="M20 13v2a4 4 0 0 1-4 4H4" />
    </>
  ),
  assets: (
    <>
      <rect height="16" rx="2" width="18" x="3" y="4" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-9 9" />
    </>
  ),
  cabs: (
    <>
      <path d="M5 16V11l2-5h10l2 5v5" />
      <path d="M3 16h18v3H3z" />
      <circle cx="7.5" cy="19.5" r="1.5" />
      <circle cx="16.5" cy="19.5" r="1.5" />
      <path d="M10 6V3h4v3" />
    </>
  ),
  analytics: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
};

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg aria-hidden className="nav-svg" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24">
      {icons[name]}
    </svg>
  );
}

const navItems = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/loops", label: "Loops", icon: "loops" },
  { href: "/assets", label: "Assets", icon: "assets" },
  { href: "/devices", label: "Cabs", icon: "cabs" },
  { href: "/analytics", label: "Analytics", icon: "analytics" },
  { href: "/settings", label: "Settings", icon: "settings" },
] satisfies Array<{ href: Route; label: string; icon: keyof typeof icons }>;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ user, children }: Props) {
  const pathname = usePathname();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <img alt="" className="brand-logo" height={40} src="/m-app/windmill-gold.png" width={30} />
          <div>
            <strong>Orison</strong>
            <p>Cab screens</p>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => (
            <Link
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
              className={isActive(pathname, item.href) ? "nav-item active" : "nav-item"}
              href={item.href}
              key={item.href}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div>
            <strong>{user.name}</strong>
            <p>{user.role === "ADMIN" ? "Admin" : "Staff"}</p>
          </div>
          <button type="button" className="button button-secondary sidebar-button" onClick={handleLogout}>
            <span className="nav-icon" aria-hidden="true">
              <Icon name="logout" />
            </span>
            <span className="nav-label">Sign out</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="page-transition" key={pathname}>
          {children}
        </div>
      </main>
    </div>
  );
}
