"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { readError } from "@/components/loop-ui";
import { useToast } from "@/components/toast-provider";
import { fillerTemplateProblems, formatSeconds, MIN_ITEM_DURATION_MS, SLOT_DURATION_MS } from "@/lib/slot-rules";

type Props = {
  settings: {
    defaultFillerTemplate: Array<{ category: string; durationMs: number }>;
    syncIntervalSeconds: number;
    heartbeatIntervalSeconds: number;
    safetyVideoAssetId: string | null;
    safetyMessageDurationSeconds: number;
    loopFrameWidth: number;
    loopFrameHeight: number;
  };
  safetyAssets: Array<{
    id: string;
    filename: string;
    durationMs: number | null;
    mimeType: string;
  }>;
  users: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
};

const fillerCategories = [
  ["ANY_FILLER", "Any filler"],
  ["FILLER_BRANDED", "Branded filler"],
  ["FILLER_OTHER", "Other filler"],
  ["FILLER_WEATHER", "Weather filler (uploaded)"],
  ["FILLER_NEWS", "News filler (uploaded)"],
] as const;

const framePresets = [
  [1280, 800, "1280 × 800 (16:10, the current format)"],
  [1920, 1080, "1920 × 1080 (16:9, Full HD)"],
  [1280, 720, "1280 × 720 (16:9, HD)"],
] as const;

export function SettingsForm({ settings, safetyAssets, users }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState({
    syncIntervalSeconds: String(settings.syncIntervalSeconds),
    heartbeatIntervalSeconds: String(settings.heartbeatIntervalSeconds),
    safetyVideoAssetId: settings.safetyVideoAssetId ?? "",
    safetyMessageDurationSeconds: String(settings.safetyMessageDurationSeconds),
    fillers: settings.defaultFillerTemplate.map((item) => ({ category: item.category, seconds: String(item.durationMs / 1000) })),
    frameWidth: String(settings.loopFrameWidth),
    frameHeight: String(settings.loopFrameHeight),
  });

  const template = state.fillers.map((item) => ({ category: item.category, durationMs: Math.round(Number.parseFloat(item.seconds) * 10) * 100 }));
  const templateProblems = template.some((item) => !Number.isFinite(item.durationMs))
    ? ["Enter a length for every row."]
    : fillerTemplateProblems(template);
  const templateTotal = template.reduce((sum, item) => sum + (Number.isFinite(item.durationMs) ? item.durationMs : 0), 0);
  const frameChanged = Number(state.frameWidth) !== settings.loopFrameWidth || Number(state.frameHeight) !== settings.loopFrameHeight;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (templateProblems.length) {
      setError(templateProblems[0]);
      return;
    }
    setSaving(true);
    setError(null);
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        syncIntervalSeconds: Number(state.syncIntervalSeconds),
        heartbeatIntervalSeconds: Number(state.heartbeatIntervalSeconds),
        safetyVideoAssetId: state.safetyVideoAssetId || null,
        safetyMessageDurationSeconds: Number(state.safetyMessageDurationSeconds),
        defaultFillerTemplate: template,
        loopFrameWidth: Number(state.frameWidth),
        loopFrameHeight: Number(state.frameHeight),
      }),
    });
    setSaving(false);
    if (!response.ok) {
      setError(await readError(response, "The settings could not be saved."));
      return;
    }
    toast({
      title: "Settings saved",
      message: frameChanged ? "New screen format saved. Publish each loop again for cabs to get it." : "Your settings are saved.",
      tone: "success",
    });
    router.refresh();
  }

  const update = (patch: Partial<typeof state>) => setState((current) => ({ ...current, ...patch }));

  return (
    <div className="stack-lg">
      <form className="stack-lg" onSubmit={handleSubmit}>
        <section className="card stack st-section">
          <div>
            <span className="eyebrow">Loop builder</span>
            <h2>Filler template</h2>
          </div>
          <p className="muted">
            &ldquo;Fill from template&rdquo; in the loop builder adds these fillers after a slot&apos;s advert, picking the newest file of each kind
            (you can change each pick before it is applied). The last row is lengthened or shortened so the slot adds up to exactly
            one minute, whatever the length of the advert. Weather and news fillers are files you upload with that label: nothing
            generates them. Leave the template empty to add fillers by hand only.
          </p>
          {state.fillers.length === 0 ? <p className="st-empty">The template is empty: &ldquo;Fill from template&rdquo; is turned off.</p> : null}
          {state.fillers.map((item, index) => (
            <div className="st-template-row" key={index}>
              <span className="st-step">{index + 1}</span>
              <select
                aria-label={`Kind of filler ${index + 1}`}
                onChange={(event) => update({ fillers: state.fillers.map((row, at) => (at === index ? { ...row, category: event.target.value } : row)) })}
                value={item.category}
              >
                {fillerCategories.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label className="lb-duration">
                <input
                  aria-label={`Length of filler ${index + 1} in seconds`}
                  inputMode="decimal"
                  onChange={(event) => update({ fillers: state.fillers.map((row, at) => (at === index ? { ...row, seconds: event.target.value } : row)) })}
                  value={item.seconds}
                />
                <span>s</span>
              </label>
              <button className="lb-text-button is-danger" onClick={() => update({ fillers: state.fillers.filter((_, at) => at !== index) })} type="button">
                Remove
              </button>
            </div>
          ))}
          <div className="st-template-foot">
            <button
              className="button button-secondary"
              onClick={() => update({ fillers: [...state.fillers, { category: "ANY_FILLER", seconds: "10" }] })}
              type="button"
            >
              Add a row
            </button>
            {state.fillers.length ? (
              <span className={templateProblems.length ? "text-danger" : "muted"}>
                {templateProblems.length
                  ? templateProblems[0]
                  : `Total ${formatSeconds(templateTotal)}: with a 12 s advert the slot is ${formatSeconds(12_000 + templateTotal)} before the last row is adjusted. Each row at least ${formatSeconds(MIN_ITEM_DURATION_MS)}, all together under ${formatSeconds(SLOT_DURATION_MS)}.`}
              </span>
            ) : null}
          </div>
        </section>

        <section className="card stack st-section">
          <div>
            <span className="eyebrow">Compiled loops</span>
            <h2>Screen format</h2>
          </div>
          <p className="muted">
            The picture size loops are compiled to. Adverts are fitted inside it without stretching (black bars where the shapes
            differ). <strong>A change only reaches a cab when its loop is published again</strong>: loops already on air keep
            playing in the format they were published in.
          </p>
          <div className="st-frame-row">
            <select
              aria-label="Screen format preset"
              onChange={(event) => {
                const [width, height] = event.target.value.split("x");
                if (width && height) update({ frameWidth: width, frameHeight: height });
              }}
              value={`${state.frameWidth}x${state.frameHeight}`}
            >
              {framePresets.map(([width, height, label]) => (
                <option key={label} value={`${width}x${height}`}>
                  {label}
                </option>
              ))}
              {!framePresets.some(([width, height]) => `${width}x${height}` === `${state.frameWidth}x${state.frameHeight}`) ? (
                <option value={`${state.frameWidth}x${state.frameHeight}`}>Custom</option>
              ) : null}
            </select>
            <label className="lb-duration">
              <input aria-label="Width in pixels" inputMode="numeric" onChange={(event) => update({ frameWidth: event.target.value })} value={state.frameWidth} />
              <span>×</span>
            </label>
            <label className="lb-duration">
              <input aria-label="Height in pixels" inputMode="numeric" onChange={(event) => update({ frameHeight: event.target.value })} value={state.frameHeight} />
              <span>px</span>
            </label>
          </div>
          {frameChanged ? <div className="alert alert-warning">After saving, publish each loop again so cabs get the new format.</div> : null}
        </section>

        <section className="card stack st-section">
          <div>
            <span className="eyebrow">Journeys</span>
            <h2>Safety message</h2>
          </div>
          <p className="muted">
            Plays once at the start of every journey, before the loop. Upload a video or an image in Assets under &ldquo;Safety
            message&rdquo;. An image stays on screen for the time set here.
          </p>
          <label className="field">
            <span>Safety message</span>
            <select onChange={(event) => update({ safetyVideoAssetId: event.target.value })} value={state.safetyVideoAssetId}>
              <option value="">None</option>
              {safetyAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.filename}
                  {asset.mimeType.startsWith("video/") ? (asset.durationMs ? ` (video, ${Math.round(asset.durationMs / 1000)} s)` : " (video)") : " (image)"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>How long an image stays on screen (seconds)</span>
            <input max={300} min={1} onChange={(event) => update({ safetyMessageDurationSeconds: event.target.value })} step={1} type="number" value={state.safetyMessageDurationSeconds} />
          </label>
        </section>

        <section className="card stack st-section">
          <div>
            <span className="eyebrow">Cabs</span>
            <h2>Check-in intervals</h2>
          </div>
          <p className="muted">
            Sent to cabs in their heartbeat reply. Cabs on firmware 1.2.0 or later use them; cabs on older firmware keep the intervals in their own
            configuration file until they are updated.
          </p>
          <div className="grid-two">
            <label className="field">
              <span>Check for a new loop every (seconds)</span>
              <input min={60} onChange={(event) => update({ syncIntervalSeconds: event.target.value })} type="number" value={state.syncIntervalSeconds} />
            </label>
            <label className="field">
              <span>Report status every (seconds)</span>
              <input min={60} onChange={(event) => update({ heartbeatIntervalSeconds: event.target.value })} type="number" value={state.heartbeatIntervalSeconds} />
            </label>
          </div>
        </section>

        {error ? <div className="alert alert-danger">{error}</div> : null}
        <div className="st-save">
          <button className="button button-primary" disabled={saving || templateProblems.length > 0} type="submit">
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>

      <section className="card stack">
        <div>
          <span className="eyebrow">Team</span>
          <h2>People who can sign in</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.role === "ADMIN" ? "Everything, and managing the team" : "Everything except managing the team"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">Cabs do not use these accounts: they identify themselves with the shared cab token set in the server&apos;s environment (DEVICE_SHARED_TOKEN).</p>
      </section>
    </div>
  );
}
