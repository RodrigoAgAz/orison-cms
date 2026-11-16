"use client";

import Link from "next/link";
import { useState } from "react";

import { LockIcon } from "../components/icons";
import { useSessionUser } from "../components/shell";
import { EmptyState, href, Notice, Screen, Spinner, TopBar } from "../components/ui";
import { api } from "../lib/api";
import { signInHref } from "./account";

export function PasswordScreen() {
  const me = useSessionUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("current") ?? "");
    const newPassword = String(data.get("next") ?? "");
    const repeat = String(data.get("repeat") ?? "");
    setError(null);
    setDone(false);
    if (newPassword.length < 8) {
      setError("The new password needs at least 8 characters.");
      return;
    }
    if (newPassword !== repeat) {
      setError("The two new passwords don’t match.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/password", { method: "POST", json: { currentPassword, newPassword } });
      setDone(true);
      form.reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  }

  if (me && !me.signedIn) {
    return (
      <Screen>
        <TopBar title="Change password" back={{ fallback: "/m/account", label: "Account" }} />
        <EmptyState
          icon={<LockIcon size={28} />}
          title="Sign in first"
          action={
            <Link href={href(signInHref("/m/account/password"))} className="m-btn m-btn-primary">
              Sign in
            </Link>
          }
        >
          You&rsquo;re not signed in, so there is no password to change here.
        </EmptyState>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title="Change password" back={{ fallback: "/m/account", label: "Account" }} />
      <form className="m-form m-card" onSubmit={onSubmit}>
        <label className="m-field">
          <span>Current password</span>
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label className="m-field">
          <span>New password</span>
          <input name="next" type="password" autoComplete="new-password" minLength={8} required />
          <small>At least 8 characters.</small>
        </label>
        <label className="m-field">
          <span>New password again</span>
          <input name="repeat" type="password" autoComplete="new-password" minLength={8} required />
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {done ? (
          <Notice tone="success" testId="password-done">
            Password changed. Use the new one next time you sign in.
          </Notice>
        ) : null}
        <button type="submit" className="m-btn m-btn-primary m-btn-block" disabled={busy}>
          {busy ? <Spinner /> : null} Change password
        </button>
      </form>
    </Screen>
  );
}
