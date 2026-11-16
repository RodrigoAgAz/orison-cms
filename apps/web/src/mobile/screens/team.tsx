"use client";

import Link from "next/link";
import { useState } from "react";

import { useSessionUser } from "../components/shell";
import { ChevronIcon, TeamIcon } from "../components/icons";
import { EmptyState, ErrorState, href, LoadingScreen, Notice, Screen, Sheet, Spinner, TopBar } from "../components/ui";
import { api } from "../lib/api";
import { longDate } from "../lib/format";
import { invalidate, useResource } from "../lib/store";
import type { Role, TeamMember } from "../lib/types";
import { initials, roleName, signInHref } from "./account";

const KEY = "/api/users";

function RolePicker({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <fieldset className="m-field m-segmented-field">
      <legend>Role</legend>
      <div className="m-segmented" role="radiogroup" aria-label="Role">
        {(["EDITOR", "ADMIN"] as const).map((role) => (
          <label key={role} className={value === role ? "is-active" : ""}>
            <input type="radio" name="role" value={role} checked={value === role} onChange={() => onChange(role)} className="m-visually-hidden" />
            {roleName(role)}
          </label>
        ))}
      </div>
      <small>
        {value === "ADMIN"
          ? "Admins can do everything, including managing the team."
          : "Editors can see the cabs and change what plays, but can’t manage the team."}
      </small>
    </fieldset>
  );
}

export function TeamScreen() {
  const me = useSessionUser();
  // Only a signed-in admin asks for the team (the API refuses everyone else).
  const team = useResource<{ items: TeamMember[] }>(me?.signedIn && me.role === "ADMIN" ? KEY : null, { refreshMs: 0 });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const top = (
    <TopBar
      title="Team"
      back={{ fallback: "/m/account", label: "Account" }}
      right={
        me?.signedIn && me.role === "ADMIN" ? (
          <button type="button" className="m-btn m-btn-secondary m-btn-small" onClick={() => setAdding(true)} data-testid="team-add">
            Add person
          </button>
        ) : null
      }
    />
  );

  if (me && !me.signedIn) {
    return (
      <Screen>
        {top}
        <EmptyState
          icon={<TeamIcon size={28} />}
          title="Sign in to manage the team"
          action={
            <Link href={href(signInHref("/m/account/team"))} className="m-btn m-btn-primary" data-testid="team-sign-in">
              Sign in
            </Link>
          }
        >
          Adding people, changing roles and resetting passwords needs an admin to sign in. Everything else works without signing in.
        </EmptyState>
      </Screen>
    );
  }

  if (me && me.role !== "ADMIN") {
    return (
      <Screen>
        {top}
        <EmptyState icon={<TeamIcon size={28} />} title="Only admins manage the team">
          Ask an admin if you need someone added or a password reset.
        </EmptyState>
      </Screen>
    );
  }

  return (
    <Screen>
      {top}
      {!team.data ? (
        team.error ? (
          <ErrorState message={team.error.message} onRetry={() => void team.refresh()} />
        ) : (
          <LoadingScreen label="Loading team" />
        )
      ) : (
        <>
          <p className="m-body-text m-pad">Everyone here can sign in to Orison. Tap a person to change their role, reset their password or remove them.</p>
          <ul className="m-list m-card" data-testid="team-list">
            {team.data.items.map((member) => (
              <li key={member.id}>
                <button type="button" className="m-listrow" onClick={() => setEditing(member)} data-testid="team-member" data-email={member.email}>
                  <span className="m-avatar m-avatar-sm" aria-hidden="true">
                    {initials(member.name)}
                  </span>
                  <span className="m-listrow-text">
                    <strong>
                      {member.name}
                      {member.id === me?.id ? <span className="m-you"> (you)</span> : null}
                    </strong>
                    <span className="m-muted">{member.email}</span>
                  </span>
                  <span className={`m-role m-role-${member.role.toLowerCase()}`}>{roleName(member.role)}</span>
                  <ChevronIcon size={18} className="m-listrow-chev" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <AddSheet open={adding} onClose={() => setAdding(false)} />
      {editing ? <EditSheet member={editing} isMe={editing.id === me?.id} onClose={() => setEditing(null)} /> : null}
    </Screen>
  );
}

function AddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [role, setRole] = useState<Role>("EDITOR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password.length < 8) {
      setError("The password needs at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(KEY, {
        method: "POST",
        json: { name: String(form.get("name") ?? "").trim(), email: String(form.get("email") ?? "").trim(), password, role },
      });
      await invalidate(KEY);
      setRole("EDITOR");
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add a person" testId="team-add-sheet">
      <form className="m-form" onSubmit={onSubmit}>
        <label className="m-field">
          <span>Name</span>
          <input name="name" required autoComplete="off" autoCapitalize="words" maxLength={120} data-testid="team-add-name" />
        </label>
        <label className="m-field">
          <span>Email</span>
          <input name="email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" required data-testid="team-add-email" />
        </label>
        <label className="m-field">
          <span>Temporary password</span>
          <input name="password" type="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" minLength={8} required data-testid="team-add-password" />
          <small>At least 8 characters. Tell them in person; they can change it under Account.</small>
        </label>
        <RolePicker value={role} onChange={setRole} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" className="m-btn m-btn-primary m-btn-block" disabled={busy} data-testid="team-add-submit">
          {busy ? <Spinner /> : null} Add to the team
        </button>
      </form>
    </Sheet>
  );
}

function EditSheet({ member, isMe, onClose }: { member: TeamMember; isMe: boolean; onClose: () => void }) {
  const [role, setRole] = useState<Role>(member.role);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "role" | "password" | "remove">(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(kind: "role" | "password" | "remove", action: () => Promise<unknown>, done: string, close = false) {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      await action();
      await invalidate(KEY);
      if (close) onClose();
      else setMessage(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open onClose={onClose} title={member.name} testId="team-edit-sheet">
      <p className="m-muted">
        {member.email} · added {longDate(member.createdAt)}
      </p>

      <div className="m-sheet-block">
        <RolePicker value={role} onChange={setRole} />
        <button
          type="button"
          className="m-btn m-btn-secondary m-btn-block"
          disabled={role === member.role || busy !== null}
          onClick={() => void run("role", () => api(`${KEY}/${member.id}`, { method: "PATCH", json: { role } }), `${member.name} is now ${roleName(role) === "Admin" ? "an Admin" : "an Editor"}.`)}
          data-testid="team-save-role"
        >
          {busy === "role" ? <Spinner /> : null} Save role
        </button>
      </div>

      <div className="m-sheet-block">
        <label className="m-field">
          <span>Reset password</span>
          <input
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="New temporary password"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            data-testid="team-reset-password"
          />
          <small>At least 8 characters. Tell them in person.</small>
        </label>
        <button
          type="button"
          className="m-btn m-btn-secondary m-btn-block"
          disabled={password.length < 8 || busy !== null}
          onClick={() =>
            void run(
              "password",
              async () => {
                await api(`${KEY}/${member.id}`, { method: "PATCH", json: { password } });
                setPassword("");
              },
              `Password reset. ${member.name} can sign in with the new one now.`,
            )
          }
          data-testid="team-save-password"
        >
          {busy === "password" ? <Spinner /> : null} Set new password
        </button>
      </div>

      {message ? (
        <Notice tone="success" testId="team-message">
          {message}
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {isMe ? (
        <p className="m-muted m-sheet-block">This is you. Someone else on the team would need to remove you.</p>
      ) : confirmRemove ? (
        <div className="m-sheet-block m-danger-zone">
          <p className="m-body-text">
            Remove {member.name}? They won&rsquo;t be able to sign in any more. Nothing on the screens changes.
          </p>
          <div className="m-row-buttons">
            <button type="button" className="m-btn m-btn-ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
            <button
              type="button"
              className="m-btn m-btn-danger"
              disabled={busy !== null}
              onClick={() => void run("remove", () => api(`${KEY}/${member.id}`, { method: "DELETE" }), "", true)}
              data-testid="team-remove-confirm"
            >
              {busy === "remove" ? <Spinner /> : null} Remove
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="m-btn m-btn-danger-ghost m-btn-block m-sheet-block" onClick={() => setConfirmRemove(true)} data-testid="team-remove">
          Remove from the team
        </button>
      )}
    </Sheet>
  );
}
