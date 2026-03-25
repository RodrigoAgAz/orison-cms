"use client";

import { useState } from "react";

export function CreateLoopForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "");

    const response = await fetch("/api/loops", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to create loop");
      setLoading(false);
      return;
    }

    const body = (await response.json()) as { id: string };
    window.location.href = `/loops/${body.id}`;
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input name="name" placeholder="Week 12 - 2026" required />
      <button className="button button-primary" disabled={loading} type="submit">
        {loading ? "Creating..." : "Create Loop"}
      </button>
      {error ? <span className="error-text">{error}</span> : null}
    </form>
  );
}

