"use client";

import { useState } from "react";

export function LoginForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const payload = {
      email: formData.get("email"),
      password: formData.get("password"),
    };

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to sign in");
      setLoading(false);
      return;
    }

    window.location.href = "/";
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <div>
        <span className="eyebrow">Internal Login</span>
        <h1>Orison Screens CMS</h1>
        <p className="muted">Use the seeded admin account or an internal editor account.</p>
      </div>

      <label className="field">
        <span>Email</span>
        <input name="email" type="email" required placeholder="admin@orisonscreens.com" />
      </label>

      <label className="field">
        <span>Password</span>
        <input name="password" type="password" required placeholder="••••••••" />
      </label>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <button className="button button-primary" disabled={loading} type="submit">
        {loading ? "Signing In..." : "Sign In"}
      </button>
    </form>
  );
}

