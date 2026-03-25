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

const navItems = [
  { href: "/", label: "Dashboard", icon: "DB" },
  { href: "/loops", label: "Loops", icon: "LP" },
  { href: "/assets", label: "Assets", icon: "AS" },
  { href: "/devices", label: "Devices", icon: "DV" },
  { href: "/analytics", label: "Analytics", icon: "AN" },
  { href: "/settings", label: "Settings", icon: "ST" },
] satisfies Array<{ href: Route; label: string; icon: string }>;

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
          <span className="brand-mark">OS</span>
          <div>
            <strong>Orison Screens</strong>
            <p>Cab Screen CMS</p>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "nav-item active" : "nav-item"}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div>
            <strong>{user.name}</strong>
            <p>{user.role}</p>
          </div>
          <button type="button" className="button button-secondary sidebar-button" onClick={handleLogout}>
            <span className="nav-icon" aria-hidden="true">
              LO
            </span>
            <span className="nav-label">Log Out</span>
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
