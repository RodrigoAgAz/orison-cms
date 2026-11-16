"use client";

import Link from "next/link";
import { useState } from "react";

import { useSessionUser } from "../components/shell";
import { ChevronIcon, DesktopIcon, LockIcon, PersonIcon, SignOutIcon, TeamIcon } from "../components/icons";
import { href, LoadingScreen, Screen, Section, Spinner, TopBar } from "../components/ui";
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

/** Sign-in page that comes back to `next` afterwards. */
export function signInHref(next: string) {
  return `/m/login?next=${encodeURIComponent(next)}`;
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
      // Open phone app: carry on without signing in. Sign-in required: back to the sign-in screen.
      window.location.replace(user?.signInRequired ? "/m/login" : "/m/account");
    }
  }

  const desktopRow = (
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
  );

  if (!user) {
    // Still finding out who this is (signed in or not): show neither version yet.
    return (
      <Screen>
        <TopBar title="Account" large />
        <LoadingScreen label="Loading your account" />
      </Screen>
    );
  }

  if (!user.signedIn) {
    return (
      <Screen>
        <TopBar title="Account" large />
        <div className="m-card m-me" data-testid="account-card" data-signed-in="false">
          <span className="m-avatar m-avatar-shared" aria-hidden="true">
            <TeamIcon size={26} />
          </span>
          <div>
            <strong data-testid="account-name">Not signed in</strong>
            <span className="m-muted">
              You can see the cabs and change what plays without signing in. Changes are recorded as &ldquo;{user.name}&rdquo;.
            </span>
          </div>
        </div>

        <Section>
          <ul className="m-list m-card">
            <li>
              <Link href={href(signInHref("/m/account"))} className="m-listrow" data-testid="account-sign-in">
                <span className="m-listrow-icon">
                  <PersonIcon size={20} />
                </span>
                <span className="m-listrow-text">
                  <strong>Sign in</strong>
                  <span className="m-muted">Admins sign in to manage the team. Signing in also puts your name on your changes.</span>
                </span>
                <ChevronIcon size={18} className="m-listrow-chev" />
              </Link>
            </li>
            {desktopRow}
          </ul>
        </Section>
        <p className="m-footnote">Orison Screens. Times are shown in London time.</p>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title="Account" large />
      <div className="m-card m-me" data-testid="account-card" data-signed-in="true">
        <span className="m-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <div>
          <strong data-testid="account-name">{user.name}</strong>
          <span className="m-muted">{user.email ?? " "}</span>
          <span className={`m-role m-role-${user.role.toLowerCase()}`}>{roleName(user.role)}</span>
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
          {user.role === "ADMIN" ? (
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
          {desktopRow}
        </ul>
      </Section>

      <Section>
        <button type="button" className="m-btn m-btn-danger-ghost m-btn-block" onClick={() => void signOut()} disabled={signingOut} data-testid="sign-out">
          {signingOut ? <Spinner /> : <SignOutIcon size={18} />} Sign out
        </button>
      </Section>
      <p className="m-footnote">
        {!user.signInRequired
          ? "Signing in is only needed to manage the team. Times are shown in London time."
          : "Orison Screens. Times are shown in London time."}
      </p>
    </Screen>
  );
}
