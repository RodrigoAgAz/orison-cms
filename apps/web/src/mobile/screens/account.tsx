"use client";

import Link from "next/link";
import { useState } from "react";

import { useSessionUser } from "../components/shell";
import { ChevronIcon, DesktopIcon, LockIcon, SignOutIcon, TeamIcon } from "../components/icons";
import { href, Screen, Section, Spinner, TopBar } from "../components/ui";
import { clearAll } from "../lib/store";

export function roleName(role: string) {
  return role === "ADMIN" ? "Admin" : "Editor";
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function AccountScreen() {
  const user = useSessionUser();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      clearAll();
      try {
        localStorage.removeItem("orison.mobile.upload");
      } catch {
        // ignore
      }
      window.location.replace("/m/login");
    }
  }

  return (
    <Screen>
      <TopBar title="Account" large />
      <div className="m-card m-me" data-testid="account-card">
        <span className="m-avatar" aria-hidden="true">
          {user ? initials(user.name) : ""}
        </span>
        <div>
          <strong data-testid="account-name">{user?.name ?? " "}</strong>
          <span className="m-muted">{user?.email ?? " "}</span>
          {user ? <span className={`m-role m-role-${user.role.toLowerCase()}`}>{roleName(user.role)}</span> : null}
        </div>
      </div>

      <Section>
        <ul className="m-list m-card">
          <li>
            <Link href={href("/m/account/password")} className="m-listrow" data-testid="account-password">
              <span className="m-listrow-icon">
                <LockIcon size={20} />
              </span>
              <span className="m-listrow-text">
                <strong>Change password</strong>
              </span>
              <ChevronIcon size={18} className="m-listrow-chev" />
            </Link>
          </li>
          {user?.role === "ADMIN" ? (
            <li>
              <Link href={href("/m/account/team")} className="m-listrow" data-testid="account-team">
                <span className="m-listrow-icon">
                  <TeamIcon size={20} />
                </span>
                <span className="m-listrow-text">
                  <strong>Team</strong>
                  <span className="m-muted">Add people, reset passwords</span>
                </span>
                <ChevronIcon size={18} className="m-listrow-chev" />
              </Link>
            </li>
          ) : null}
          <li>
            <a href="/?view=desktop" className="m-listrow">
              <span className="m-listrow-icon">
                <DesktopIcon size={20} />
              </span>
              <span className="m-listrow-text">
                <strong>Use the desktop site</strong>
                <span className="m-muted">Full controls, made for a computer</span>
              </span>
              <ChevronIcon size={18} className="m-listrow-chev" />
            </a>
          </li>
        </ul>
      </Section>

      <Section>
        <button type="button" className="m-btn m-btn-danger-ghost m-btn-block" onClick={() => void signOut()} disabled={signingOut} data-testid="sign-out">
          {signingOut ? <Spinner /> : <SignOutIcon size={18} />} Sign out
        </button>
      </Section>
      <p className="m-footnote">Orison Screens. Times are shown in London time.</p>
    </Screen>
  );
}
