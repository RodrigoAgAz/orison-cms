"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { MediaPoster } from "@/components/media-poster";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast-provider";
import {
  ConfirmDialog,
  LoopStatusBadge,
  PublishProgress,
  formatClock,
  formatWhen,
  readError,
  useLeaveGuard,
  useLoopState,
  type ConfirmRequest,
  type LoopStateView,
} from "@/components/loop-ui";
import {
  DURATION_STEP_MS,
  MIN_ITEM_DURATION_MS,
  SLOT_DURATION_MS,
  defaultAdvertDurationMs,
  describeArithmetic,
  draftSlotProblems,
  fitOf,
  fitTemplateDurations,
  fitWarning,
  formatSeconds,
  publishSlotProblems,
  slotArithmetic,
  withSequentialStartTimes,
} from "@/lib/slot-rules";

export type AssetOption = {
  id: string;
  filename: string;
  category: string;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  previewUrl: string;
  metadata: Record<string, string>;
  hidden?: boolean;
};

type Item = {
  key: string;
  assetId: string;
  orderInSlot: number;
  startTimeMs: number;
  durationMs: number;
  contentType: "ADVERTISEMENT" | "FILLER";
};

type SlotState = {
  position: number;
  updatedAt: string;
  staticCreativeId: string | null;
  items: Item[];
};

type Props = {
  loop: {
    id: string;
    name: string;
    updatedAt: string;
    targetGroupId: string | null;
    slots: Array<{
      position: number;
      updatedAt: string;
      staticCreativeId: string | null;
      contents: Array<Omit<Item, "key">>;
    }>;
  };
  initialState: LoopStateView;
  assets: AssetOption[];
  deviceGroups: Array<{ id: string; name: string }>;
  fillerTemplate: Array<{ category: string; durationMs: number }>;
  frame: { width: number; height: number };
};

const categoryLabels: Record<string, string> = {
  ADVERTISEMENT: "Advert",
  STATIC_CREATIVE: "Still image",
  FILLER_WEATHER: "Weather filler",
  FILLER_NEWS: "News filler",
  FILLER_BRANDED: "Branded filler",
  FILLER_OTHER: "Other filler",
  ANY_FILLER: "Any filler",
};

let keySeed = 0;
const newKey = () => `item-${(keySeed += 1)}`;

function toSlotState(slot: Props["loop"]["slots"][number]): SlotState {
  return {
    position: slot.position,
    updatedAt: slot.updatedAt,
    staticCreativeId: slot.staticCreativeId,
    items: withSequentialStartTimes(slot.contents.map((content) => ({ ...content, key: newKey() }))),
  };
}

function slotSignature(slot: SlotState) {
  return JSON.stringify([slot.staticCreativeId, slot.items.map((item) => [item.assetId, item.durationMs, item.contentType])]);
}

function lengthLabel(asset: AssetOption | undefined) {
  if (!asset) return "missing file";
  if (asset.mimeType.startsWith("image/")) return "still image";
  return asset.durationMs ? `file ${formatSeconds(Math.round(asset.durationMs / 100) * 100)}` : "length unknown";
}

function DurationInput({ valueMs, onCommit, label }: { valueMs: number; onCommit: (ms: number) => void; label: string }) {
  const [draft, setDraft] = useState((valueMs / 1000).toFixed(1));
  useEffect(() => setDraft((valueMs / 1000).toFixed(1)), [valueMs]);
  function commit() {
    const seconds = Number.parseFloat(draft.replace(",", "."));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setDraft((valueMs / 1000).toFixed(1)); // an empty or invalid entry changes nothing
      return;
    }
    const ms = Math.max(MIN_ITEM_DURATION_MS, Math.min(SLOT_DURATION_MS, Math.round((seconds * 1000) / DURATION_STEP_MS) * DURATION_STEP_MS));
    setDraft((ms / 1000).toFixed(1));
    if (ms !== valueMs) onCommit(ms);
  }
  return (
    <label className="lb-duration">
      <span className="sr-only">{label}</span>
      <input
        aria-label={label}
        inputMode="decimal"
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") setDraft((valueMs / 1000).toFixed(1));
        }}
        type="text"
        value={draft}
      />
      <span>s</span>
    </label>
  );
}

function SlotBar({ slot, assetMap, large = false }: { slot: SlotState; assetMap: Map<string, AssetOption>; large?: boolean }) {
  const arithmetic = slotArithmetic(slot.items);
  const scale = Math.max(SLOT_DURATION_MS, arithmetic.totalMs);
  return (
    <div className={`lb-bar ${large ? "is-large" : ""}`} aria-hidden>
      {slot.items.map((item) => {
        const asset = assetMap.get(item.assetId);
        const fit = fitOf(asset, item.durationMs);
        const heldPart = fit.kind === "held" ? fit.byMs / item.durationMs : 0;
        return (
          <span
            className={`lb-bar-seg ${item.contentType === "ADVERTISEMENT" ? "is-ad" : fit.kind === "still" ? "is-still" : "is-filler"}`}
            key={item.key}
            style={{ width: `${(item.durationMs / scale) * 100}%` }}
            title={`${asset?.filename ?? "?"}: ${formatSeconds(item.durationMs)}`}
          >
            {heldPart > 0 ? <span className="lb-bar-held" style={{ width: `${heldPart * 100}%` }} /> : null}
            {large ? <em>{formatSeconds(item.durationMs)}</em> : null}
          </span>
        );
      })}
      {arithmetic.remainingMs > 0 ? <span className="lb-bar-gap" style={{ width: `${(arithmetic.remainingMs / scale) * 100}%` }} /> : null}
    </div>
  );
}

type PickerKind = { kind: "advert" } | { kind: "filler"; replaceKey?: string } | { kind: "still" };

export function LoopBuilder({ loop, initialState, assets, deviceGroups, fillerTemplate, frame }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const adverts = assets.filter((asset) => asset.category === "ADVERTISEMENT" && !asset.hidden);
  const fillers = assets.filter((asset) => asset.category.startsWith("FILLER_") && !asset.hidden);
  const stills = assets.filter((asset) => asset.category === "STATIC_CREATIVE" && !asset.hidden);

  const [slots, setSlots] = useState<SlotState[]>(() => loop.slots.map(toSlotState));
  const [baseline, setBaseline] = useState<Record<number, string>>(() =>
    Object.fromEntries(loop.slots.map((slot) => [slot.position, slotSignature(toSlotState(slot))])),
  );
  const [name, setName] = useState(loop.name);
  const [savedName, setSavedName] = useState(loop.name);
  const [loopUpdatedAt, setLoopUpdatedAt] = useState(loop.updatedAt);
  const [targetGroupId, setTargetGroupId] = useState(loop.targetGroupId ?? "");
  const [selected, setSelected] = useState(0);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState<"slot" | "loop" | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useLoopState(loop.id, initialState, (settled) => {
    if (settled.publish.kind === "idle" && !settled.publishError) {
      toast({ title: "Published", message: `"${settled.name}" is published${settled.live ? ` and on air for ${settled.liveLabel}` : ""}.`, tone: "success" });
    } else if (settled.publishError) {
      toast({ title: "Publish failed", message: settled.publishError, tone: "error" });
    }
    router.refresh();
  });

  const dirtyPositions = slots.filter((slot) => slotSignature(slot) !== baseline[slot.position]).map((slot) => slot.position);
  const nameDirty = name.trim() !== savedName;
  const dirty = dirtyPositions.length > 0 || nameDirty;
  const markSaved = useLeaveGuard(dirty);
  const publishing = state.publish.kind === "running";

  const slot = slots.find((entry) => entry.position === selected) ?? slots[0];
  const advert = slot?.items.find((item) => item.contentType === "ADVERTISEMENT");
  const arithmetic = slot ? slotArithmetic(slot.items) : null;
  const readyCount = slots.filter((entry) => entry.items.length > 0 && publishSlotProblems(entry.items).length === 0).length;
  const warnings = slots.flatMap((entry) =>
    entry.items
      .map((item) => ({ position: entry.position, item, text: fitWarning({ ...item, asset: assetMap.get(item.assetId) }) }))
      .filter((warning): warning is { position: number; item: Item; text: string } => Boolean(warning.text)),
  );
  const targetLabel = targetGroupId ? `group ${deviceGroups.find((group) => group.id === targetGroupId)?.name ?? "?"}` : "all cabs";

  function updateSlot(position: number, change: (slot: SlotState) => SlotState) {
    setSlots((current) =>
      current.map((entry) => {
        if (entry.position !== position) return entry;
        const next = change(entry);
        return { ...next, items: withSequentialStartTimes(next.items) };
      }),
    );
    setError(null);
  }

  function setItems(items: Item[]) {
    updateSlot(selected, (entry) => ({ ...entry, items: items.map((item, index) => ({ ...item, orderInSlot: index })) }));
  }

  function chooseAdvert(asset: AssetOption) {
    const durationMs = defaultAdvertDurationMs(asset);
    const others = slot.items.filter((item) => item.contentType !== "ADVERTISEMENT");
    setItems([{ key: newKey(), assetId: asset.id, orderInSlot: 0, startTimeMs: 0, durationMs, contentType: "ADVERTISEMENT" }, ...others]);
    setPicker(null);
  }

  function chooseFiller(asset: AssetOption, replaceKey?: string) {
    if (replaceKey) {
      setItems(slot.items.map((item) => (item.key === replaceKey ? { ...item, assetId: asset.id } : item)));
    } else {
      const remaining = SLOT_DURATION_MS - slotArithmetic(slot.items).totalMs;
      const natural = asset.mimeType.startsWith("image/") || !asset.durationMs ? 10_000 : Math.round(asset.durationMs / 100) * 100;
      const durationMs = Math.max(MIN_ITEM_DURATION_MS, remaining >= MIN_ITEM_DURATION_MS ? Math.min(natural, remaining) : natural);
      setItems([...slot.items, { key: newKey(), assetId: asset.id, orderInSlot: slot.items.length, startTimeMs: 0, durationMs, contentType: "FILLER" }]);
    }
    setPicker(null);
  }

  function chooseStill(asset: AssetOption | null) {
    updateSlot(selected, (entry) => ({ ...entry, staticCreativeId: asset?.id ?? null }));
    setPicker(null);
  }

  function moveItem(key: string, by: -1 | 1) {
    const index = slot.items.findIndex((item) => item.key === key);
    const target = index + by;
    if (index < 0 || target < 0 || target >= slot.items.length) return;
    const items = slot.items.slice();
    [items[index], items[target]] = [items[target], items[index]];
    setItems(items);
  }

  function fillTheRest() {
    if (!arithmetic || arithmetic.remainingMs === 0) return;
    const last = [...slot.items].reverse().find((item) => item.contentType === "FILLER");
    if (!last) return;
    const durationMs = last.durationMs + arithmetic.remainingMs;
    if (durationMs < MIN_ITEM_DURATION_MS) {
      setError("The last filler cannot absorb that much. Remove a filler or shorten the advert.");
      return;
    }
    setItems(slot.items.map((item) => (item.key === last.key ? { ...item, durationMs } : item)));
  }

  async function save(options: { quiet?: boolean } = {}) {
    if (!dirty) return true;
    const invalid = slots
      .filter((entry) => dirtyPositions.includes(entry.position))
      .map((entry) => ({ position: entry.position, problems: draftSlotProblems(entry.items) }))
      .find((entry) => entry.problems.length > 0);
    if (invalid) {
      setSelected(invalid.position);
      setError(`Slot ${invalid.position + 1}: ${invalid.problems[0]}`);
      return false;
    }
    setBusy("save");
    setError(null);
    try {
      if (nameDirty) {
        const response = await fetch(`/api/loops/${loop.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), expectedUpdatedAt: loopUpdatedAt }),
        });
        if (!response.ok) throw new Error(await readError(response, "The name could not be saved."));
        const saved = (await response.json()) as { name: string; updatedAt: string };
        setSavedName(saved.name);
        setName(saved.name);
        setLoopUpdatedAt(saved.updatedAt);
      }
      if (dirtyPositions.length) {
        const response = await fetch(`/api/loops/${loop.id}/slots`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slots: slots
              .filter((entry) => dirtyPositions.includes(entry.position))
              .map((entry) => ({
                position: entry.position,
                staticCreativeId: entry.staticCreativeId,
                expectedUpdatedAt: entry.updatedAt,
                contents: entry.items.map(({ key: _key, ...content }) => content),
              })),
          }),
        });
        if (!response.ok) throw new Error(await readError(response, "The slots could not be saved."));
        const body = (await response.json()) as { slots: Array<{ position: number; updatedAt: string }>; state: LoopStateView };
        const stamps = new Map(body.slots.map((entry) => [entry.position, entry.updatedAt]));
        const saved = slots.map((entry) => ({ ...entry, updatedAt: stamps.get(entry.position) ?? entry.updatedAt }));
        setSlots(saved);
        setBaseline(Object.fromEntries(saved.map((entry) => [entry.position, slotSignature(entry)])));
        setState(body.state);
      }
      markSaved();
      if (!options.quiet) toast({ title: "Saved", message: state.status === "PUBLISHED" ? "Saved. Cabs still play the published version until you publish again." : "Your changes are saved.", tone: "success" });
      return true;
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Could not save.";
      setError(message);
      toast({ title: "Not saved", message, tone: "error" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  function askPublish() {
    const notReady = slots.find((entry) => entry.items.length === 0 || publishSlotProblems(entry.items).length > 0);
    if (notReady) {
      setSelected(notReady.position);
      setError(`Slot ${notReady.position + 1} is not ready: ${notReady.items.length === 0 ? "it is empty." : publishSlotProblems(notReady.items)[0]}`);
      return;
    }
    const lines = warnings.slice(0, 8).map((warning) => `Slot ${warning.position + 1}: ${warning.text}`);
    if (warnings.length > 8) lines.push(`…and ${warnings.length - 8} more.`);
    setConfirm({
      title: `Publish to ${targetLabel}?`,
      message:
        (state.live
          ? `This replaces the version on air for ${state.liveLabel} once the new one is ready; until then the current version keeps playing.`
          : `It goes on air for ${targetLabel} as soon as it is compiled (a few minutes).`) +
        (warnings.length ? " Check what happens to files that do not match their time:" : ""),
      lines,
      confirmLabel: "Publish",
      onConfirm: publish,
    });
  }

  async function publish() {
    if (!(await save({ quiet: true }))) return;
    setBusy("publish");
    try {
      const response = await fetch(`/api/loops/${loop.id}/publish`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response, "Publishing could not start."));
      const body = (await response.json()) as { state: LoopStateView; kind: string };
      setState(body.state);
      if (body.state.publish.kind !== "running") {
        toast({ title: "Published", message: "Nothing had changed, so cabs keep what they have.", tone: "success" });
        router.refresh();
      }
    } catch (publishError) {
      const message = publishError instanceof Error ? publishError.message : "Publishing could not start.";
      setError(message);
      toast({ title: "Not published", message, tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function changeTarget(nextId: string, token?: string) {
    setBusy("target");
    try {
      const response = await fetch(`/api/loops/${loop.id}/target`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetGroupId: nextId || null, token: token ?? null }),
      });
      if (!response.ok) throw new Error(await readError(response, "The target could not be changed."));
      const body = (await response.json()) as { needsConfirmation?: boolean; message?: string; lines: string[]; token?: string; live?: boolean };
      if (body.needsConfirmation) {
        setConfirm({
          title: "Change where this loop plays?",
          message: body.message ?? "",
          lines: body.lines.length ? body.lines : ["No cab plays anything different right now."],
          confirmLabel: "Move it now",
          onConfirm: () => changeTarget(nextId, body.token),
        });
        return;
      }
      setTargetGroupId(nextId);
      toast({
        title: "Target changed",
        message: body.live ? "Cabs were updated." : `It will publish to ${nextId ? `group ${deviceGroups.find((group) => group.id === nextId)?.name}` : "all cabs"}.`,
        tone: "success",
      });
      router.refresh();
    } catch (targetError) {
      toast({ title: "Not changed", message: targetError instanceof Error ? targetError.message : "", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function pause(token?: string) {
    setBusy("pause");
    try {
      const response = await fetch(`/api/loops/${loop.id}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token ?? null }),
      });
      if (!response.ok) throw new Error(await readError(response, "The loop could not be paused."));
      const body = (await response.json()) as { needsConfirmation?: boolean; message?: string; lines: string[]; token?: string };
      if (body.needsConfirmation) {
        setConfirm({
          title: "Take this loop off air?",
          message: `${body.message} What plays instead:`,
          lines: body.lines,
          confirmLabel: "Pause it",
          danger: true,
          onConfirm: () => pause(body.token),
        });
        return;
      }
      toast({ title: "Paused", message: `"${name}" is off air. Publish it again to put it back.`, tone: "success" });
      router.refresh();
    } catch (pauseError) {
      toast({ title: "Not paused", message: pauseError instanceof Error ? pauseError.message : "", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function askDelete() {
    setConfirm({
      title: `Delete "${name}"?`,
      message: "The loop, its compiled video and its files in storage are deleted for good. The adverts and fillers stay in the library.",
      confirmLabel: "Delete loop",
      danger: true,
      onConfirm: async () => {
        const response = await fetch(`/api/loops/${loop.id}`, { method: "DELETE" });
        if (!response.ok) {
          toast({ title: "Not deleted", message: await readError(response, "The loop could not be deleted."), tone: "error" });
          return;
        }
        markSaved();
        toast({ title: "Deleted", message: `"${name}" was deleted.`, tone: "success" });
        router.push("/loops");
        router.refresh();
      },
    });
  }

  async function duplicate() {
    if (dirty && !window.confirm("Duplicate the saved version? Your unsaved changes are not copied.")) return;
    setBusy("duplicate");
    try {
      const response = await fetch(`/api/loops/${loop.id}/duplicate`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response, "The loop could not be duplicated."));
      const copy = (await response.json()) as { id: string; name: string };
      markSaved();
      toast({ title: "Duplicated", message: `Opened "${copy.name}".`, tone: "success" });
      router.push(`/loops/${copy.id}`);
    } catch (duplicateError) {
      toast({ title: "Not duplicated", message: duplicateError instanceof Error ? duplicateError.message : "", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (!slot || !arithmetic) {
    return null;
  }
  const slotProblems = slot.items.length ? publishSlotProblems(slot.items) : ["Choose an advert."];
  const still = slot.staticCreativeId ? assetMap.get(slot.staticCreativeId) : undefined;

  return (
    <div className="lb">
      <header className="lb-head card">
        <div className="lb-head-main">
          <Link className="lb-back" href="/loops">
            ← Loops
          </Link>
          <div className="lb-title-row">
            <input
              aria-label="Loop name"
              className="lb-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <LoopStatusBadge state={state} />
            {state.unpublishedChanges || (dirty && state.status === "PUBLISHED") ? (
              <span className="lx-badge lx-badge-warn">Changes not yet published</span>
            ) : null}
          </div>
          <dl className="lb-facts">
            <div>
              <dt>On air</dt>
              <dd>{state.live ? state.liveLabel : state.status === "PUBLISHED" ? "Not playing anywhere (something newer plays on its target)" : "No"}</dd>
            </div>
            <div>
              <dt>Plays on</dt>
              <dd>
                <select
                  aria-label="Plays on"
                  disabled={busy !== null || publishing}
                  onChange={(event) => void changeTarget(event.target.value)}
                  value={targetGroupId}
                >
                  <option value="">All cabs</option>
                  {deviceGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      Group {group.name}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
            <div>
              <dt>Last published</dt>
              <dd>{formatWhen(state.publishedAt)}</dd>
            </div>
            <div>
              <dt>Slots ready</dt>
              <dd>
                {readyCount} of {slots.length}
              </dd>
            </div>
          </dl>
        </div>
        <div className="lb-actions">
          <div className="button-row">
            <button className="button button-secondary" disabled={busy !== null} onClick={() => setPreviewOpen("loop")} type="button">
              Preview
            </button>
            <button className="button button-secondary" disabled={busy !== null} onClick={() => void duplicate()} type="button">
              Duplicate
            </button>
            {state.status === "PUBLISHED" ? (
              <button className="button button-secondary" disabled={busy !== null || publishing} onClick={() => void pause()} type="button">
                {busy === "pause" ? "Pausing…" : "Pause"}
              </button>
            ) : (
              <button className="button button-danger" disabled={busy !== null || publishing} onClick={askDelete} type="button">
                Delete
              </button>
            )}
          </div>
          <div className="button-row">
            <button className="button button-secondary" disabled={!dirty || busy !== null} onClick={() => void save()} type="button">
              {busy === "save" ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
            <button className="button button-primary" disabled={busy !== null || publishing} onClick={askPublish} type="button">
              {publishing ? "Publishing…" : state.status === "PUBLISHED" ? "Publish again" : "Publish"}
            </button>
          </div>
        </div>
      </header>

      {publishing ? <PublishProgress state={state} /> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}
      {!publishing && state.publishError ? (
        <div className="alert alert-danger">
          <strong>Last publish did not go through.</strong> {state.publishError}
        </div>
      ) : null}
      {state.unpublishedChanges && !publishing ? (
        <div className="alert alert-warning">
          The saved slots differ from what cabs are playing. Publish to send the changes to cabs.
        </div>
      ) : null}

      <section className="card lb-overview" aria-label="Slots">
        <div className="lb-section-head">
          <div>
            <span className="eyebrow">Ten one-minute slots · {formatClock(0)}–10:00</span>
            <h2>Running order</h2>
          </div>
          <div className="lb-legend">
            <span><i className="is-ad" /> Advert</span>
            <span><i className="is-filler" /> Filler</span>
            <span><i className="is-still" /> Still image</span>
            <span><i className="is-held" /> Held on last frame</span>
          </div>
        </div>
        <div className="lb-slot-grid">
          {slots.map((entry) => {
            const entryAdvert = entry.items.find((item) => item.contentType === "ADVERTISEMENT");
            const entryAsset = entryAdvert ? assetMap.get(entryAdvert.assetId) : undefined;
            const entryArithmetic = slotArithmetic(entry.items);
            const problems = entry.items.length ? publishSlotProblems(entry.items) : ["Empty"];
            const entryWarnings = warnings.filter((warning) => warning.position === entry.position).length;
            const status = problems.length === 0
              ? { text: entryWarnings ? `Ready · ${entryWarnings} note${entryWarnings === 1 ? "" : "s"}` : "Ready", tone: entryWarnings ? "note" : "ok" }
              : entry.items.length === 0
                ? { text: "Empty", tone: "bad" }
                : !entryAdvert
                  ? { text: "No advert", tone: "bad" }
                  : entryArithmetic.remainingMs > 0
                    ? { text: `${formatSeconds(entryArithmetic.remainingMs)} short`, tone: "bad" }
                    : { text: `${formatSeconds(-entryArithmetic.remainingMs)} over`, tone: "bad" };
            return (
              <button
                className={`lb-slot ${entry.position === selected ? "is-active" : ""} ${dirtyPositions.includes(entry.position) ? "is-dirty" : ""}`}
                key={entry.position}
                onClick={() => setSelected(entry.position)}
                type="button"
              >
                <div className="lb-slot-top">
                  <span className="lb-slot-number">{entry.position + 1}</span>
                  <span className="lb-slot-time">{formatClock(entry.position * SLOT_DURATION_MS)}</span>
                  <span className={`lb-slot-status is-${status.tone}`}>{status.text}</span>
                </div>
                <MediaPoster alt={entryAsset?.filename ?? ""} className="lb-slot-poster" label="No advert" src={entryAsset?.thumbnailUrl} />
                <strong className="lb-slot-name">{entryAsset?.filename ?? "Choose an advert"}</strong>
                <SlotBar assetMap={assetMap} slot={entry} />
              </button>
            );
          })}
        </div>
        {warnings.length ? (
          <p className="lb-note">
            {warnings.length} item{warnings.length === 1 ? " does" : "s do"} not match {warnings.length === 1 ? "its" : "their"} time: open the slot to see what will be cut off or held.
          </p>
        ) : null}
      </section>

      <section className="card lb-editor" aria-label={`Slot ${selected + 1}`}>
        <div className="lb-section-head">
          <div>
            <span className="eyebrow">
              Slot {selected + 1} · plays {formatClock(selected * SLOT_DURATION_MS)}–{formatClock((selected + 1) * SLOT_DURATION_MS)} in the loop
            </span>
            <h2>{advert ? assetMap.get(advert.assetId)?.filename : "Choose an advert"}</h2>
          </div>
          <div className="button-row">
            <button className="button button-secondary" onClick={() => setPreviewOpen("slot")} type="button">
              Preview slot
            </button>
          </div>
        </div>

        <SlotBar assetMap={assetMap} large slot={slot} />
        <div className={`lb-sum ${slotProblems.length ? "is-bad" : "is-ok"}`}>
          <span className="lb-sum-text">{describeArithmetic(arithmetic)}</span>
          {arithmetic.remainingMs !== 0 && slot.items.some((item) => item.contentType === "FILLER") ? (
            <button className="button button-secondary" onClick={fillTheRest} type="button">
              {arithmetic.remainingMs > 0 ? `Give the last filler ${formatSeconds(arithmetic.remainingMs)} more` : `Take ${formatSeconds(-arithmetic.remainingMs)} off the last filler`}
            </button>
          ) : null}
        </div>
        {slotProblems.length && slot.items.length ? <p className="lb-problem">To publish: {slotProblems.join(" ")}</p> : null}

        <div className="lb-editor-grid">
          <div className="lb-items">
            {slot.items.length === 0 ? (
              <div className="empty-state compact">
                <strong>This slot is empty</strong>
                <p>Start with the advert. It takes the length of its file; fillers take the rest of the minute.</p>
              </div>
            ) : null}
            {slot.items.map((item, index) => {
              const asset = assetMap.get(item.assetId);
              const fit = fitOf(asset, item.durationMs);
              const warning = fitWarning({ ...item, asset });
              return (
                <div className={`lb-item ${item.contentType === "ADVERTISEMENT" ? "is-ad" : ""}`} key={item.key}>
                  <div className="lb-item-when">
                    <span>{formatClock(item.startTimeMs)}</span>
                    <span className="muted">{formatClock(item.startTimeMs + item.durationMs)}</span>
                  </div>
                  <MediaPoster
                    alt={asset?.filename ?? ""}
                    className="lb-item-thumb"
                    label={asset?.mimeType.startsWith("image/") ? "Image" : "Video"}
                    src={asset?.thumbnailUrl ?? null}
                  />
                  <div className="lb-item-copy">
                    <span className={`lb-kind ${item.contentType === "ADVERTISEMENT" ? "is-ad" : ""}`}>
                      {item.contentType === "ADVERTISEMENT" ? "Advert" : categoryLabels[asset?.category ?? ""] ?? "Filler"}
                    </span>
                    <strong title={asset?.filename}>{asset?.filename ?? "File missing"}</strong>
                    <span className="muted">
                      {lengthLabel(asset)}
                      {asset?.hidden ? " · removed from the library" : ""}
                    </span>
                    {warning ? <span className={`lb-fit is-${fit.kind}`}>{warning}</span> : null}
                  </div>
                  <div className="lb-item-controls">
                    <span className="lb-plays">plays for</span>
                    <DurationInput
                      label={`Length of ${asset?.filename ?? "item"} in seconds`}
                      onCommit={(ms) => setItems(slot.items.map((entry) => (entry.key === item.key ? { ...entry, durationMs: ms } : entry)))}
                      valueMs={item.durationMs}
                    />
                    <div className="lb-item-buttons">
                      <button aria-label="Move earlier" className="lb-icon-button" disabled={index === 0} onClick={() => moveItem(item.key, -1)} type="button">
                        ↑
                      </button>
                      <button aria-label="Move later" className="lb-icon-button" disabled={index === slot.items.length - 1} onClick={() => moveItem(item.key, 1)} type="button">
                        ↓
                      </button>
                      {item.contentType === "ADVERTISEMENT" ? (
                        <button className="lb-text-button" onClick={() => setPicker({ kind: "advert" })} type="button">
                          Change
                        </button>
                      ) : (
                        <button className="lb-text-button" onClick={() => setPicker({ kind: "filler", replaceKey: item.key })} type="button">
                          Change
                        </button>
                      )}
                      <button className="lb-text-button is-danger" onClick={() => setItems(slot.items.filter((entry) => entry.key !== item.key))} type="button">
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="button-row lb-add-row">
              {!advert ? (
                <button className="button button-primary" disabled={adverts.length === 0} onClick={() => setPicker({ kind: "advert" })} type="button">
                  Choose advert
                </button>
              ) : null}
              <button className="button button-secondary" disabled={fillers.length === 0} onClick={() => setPicker({ kind: "filler" })} type="button">
                Add filler
              </button>
              <button
                className="button button-secondary"
                disabled={!advert || fillerTemplate.length === 0 || fillers.length === 0}
                onClick={() => setTemplateOpen(true)}
                title={fillerTemplate.length === 0 ? "The filler template in Settings is empty." : undefined}
                type="button"
              >
                Fill from template…
              </button>
            </div>
            {adverts.length === 0 ? <p className="muted">No adverts in the library yet: upload one in Assets.</p> : null}
          </div>

          <aside className="lb-still">
            <span className="eyebrow">Between journeys</span>
            <h3>Still image for this minute</h3>
            <MediaPoster
              alt={still?.filename ?? "Orison logo"}
              className="lb-still-poster"
              label={still ? "Still image" : ""}
              src={still?.thumbnailUrl ?? still?.previewUrl ?? null}
            />
            {still ? (
              <p className="muted">{still.filename}</p>
            ) : (
              <div className="lb-still-default">
                <img alt="" src="/m-app/windmill-gold.png" />
                <p>No still image chosen: between journeys the cab shows the Orison logo during this minute.</p>
              </div>
            )}
            <div className="button-row">
              <button className="button button-secondary" disabled={stills.length === 0} onClick={() => setPicker({ kind: "still" })} type="button">
                {still ? "Change" : "Choose still image"}
              </button>
              {still ? (
                <button className="button button-secondary" onClick={() => chooseStill(null)} type="button">
                  Use the logo
                </button>
              ) : null}
            </div>
          </aside>
        </div>
      </section>

      {picker ? (
        <AssetPicker
          assets={picker.kind === "advert" ? adverts : picker.kind === "still" ? stills : fillers}
          onChoose={(asset) => (picker.kind === "advert" ? chooseAdvert(asset) : picker.kind === "still" ? chooseStill(asset) : chooseFiller(asset, picker.replaceKey))}
          onClose={() => setPicker(null)}
          selectedId={picker.kind === "advert" ? advert?.assetId : picker.kind === "still" ? slot.staticCreativeId : undefined}
          title={picker.kind === "advert" ? `Advert for slot ${selected + 1}` : picker.kind === "still" ? `Still image for slot ${selected + 1}` : `Filler for slot ${selected + 1}`}
          note={
            picker.kind === "advert"
              ? "An advert plays for the length of its file. You can shorten it afterwards."
              : picker.kind === "filler"
                ? `This slot has ${formatSeconds(Math.max(arithmetic.remainingMs, 0))} left.`
                : "Shown on the cab's screen between journeys during this minute."
          }
        />
      ) : null}

      {templateOpen && advert ? (
        <TemplateDialog
          advertMs={arithmetic.advertMs}
          fillers={fillers}
          onApply={(items) => {
            setItems([slot.items.find((item) => item.contentType === "ADVERTISEMENT")!, ...items.map((entry) => ({ ...entry, key: newKey(), orderInSlot: 0, startTimeMs: 0, contentType: "FILLER" as const }))]);
            setTemplateOpen(false);
            toast({ title: "Fillers added", message: `Slot ${selected + 1}: ${items.length} filler${items.length === 1 ? "" : "s"} from the template.`, tone: "success" });
          }}
          onClose={() => setTemplateOpen(false)}
          template={fillerTemplate}
        />
      ) : null}

      {previewOpen ? (
        <PreviewPlayer
          assetMap={assetMap}
          onClose={() => setPreviewOpen(null)}
          slots={previewOpen === "slot" ? [slot] : slots}
          frame={frame}
        />
      ) : null}

      {confirm ? <ConfirmDialog onClose={() => setConfirm(null)} request={confirm} /> : null}
    </div>
  );
}

function AssetPicker({
  assets,
  onChoose,
  onClose,
  selectedId,
  title,
  note,
}: {
  assets: AssetOption[];
  onChoose: (asset: AssetOption) => void;
  onClose: () => void;
  selectedId?: string | null;
  title: string;
  note: string;
}) {
  const [query, setQuery] = useState("");
  const shown = assets.filter((asset) => `${asset.filename} ${Object.values(asset.metadata).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal className="lb-picker" eyebrow="Choose from the library" onClose={onClose} title={title}>
      <div className="stack">
        <div className="lb-picker-bar">
          <p className="muted">{note}</p>
          <input autoFocus className="lb-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, advertiser or campaign" value={query} />
        </div>
        {shown.length === 0 ? (
          <div className="empty-state compact">
            <strong>Nothing to choose</strong>
            <p>Upload files in Assets first.</p>
          </div>
        ) : (
          <div className="lb-picker-grid">
            {shown.map((asset) => (
              <button className={`lb-pick ${selectedId === asset.id ? "is-selected" : ""}`} key={asset.id} onClick={() => onChoose(asset)} type="button">
                <MediaPoster alt={asset.filename} className="lb-pick-poster" label={asset.mimeType.startsWith("image/") ? "Image" : "Video"} src={asset.thumbnailUrl} />
                <span className="lb-pick-length">{lengthLabel(asset).replace("file ", "")}</span>
                <strong>{asset.filename}</strong>
                <span className="muted">
                  {categoryLabels[asset.category] ?? asset.category}
                  {asset.metadata.advertiserName ? ` · ${asset.metadata.advertiserName}` : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function TemplateDialog({
  template,
  fillers,
  advertMs,
  onApply,
  onClose,
}: {
  template: Array<{ category: string; durationMs: number }>;
  fillers: AssetOption[];
  advertMs: number;
  onApply: (items: Array<{ assetId: string; durationMs: number }>) => void;
  onClose: () => void;
}) {
  const fitted = fitTemplateDurations(template, SLOT_DURATION_MS - advertMs);
  const eligible = (category: string) => fillers.filter((asset) => category === "ANY_FILLER" || asset.category === category);
  // Newest matching file first (the library is newest first); any filler if none in the category.
  const [choices, setChoices] = useState(() =>
    template.map((row, index) => {
      const list = eligible(row.category);
      const pool = list.length ? list : fillers;
      return pool[index % Math.max(pool.length, 1)]?.id ?? "";
    }),
  );
  return (
    <Modal className="lb-template" eyebrow="Filler template (Settings)" onClose={onClose} title="Fill the rest of the minute">
      <div className="stack">
        {!fitted.ok ? (
          <div className="alert alert-danger">{fitted.reason}</div>
        ) : (
          <>
            <p className="muted">
              The advert takes {formatSeconds(advertMs)}, leaving {formatSeconds(SLOT_DURATION_MS - advertMs)}.
              {fitted.adjustedLastByMs !== 0
                ? ` The last row is ${fitted.adjustedLastByMs > 0 ? "lengthened" : "shortened"} by ${formatSeconds(Math.abs(fitted.adjustedLastByMs))} so the slot adds up to exactly one minute.`
                : ""}{" "}
              Pick the file for each row:
            </p>
            {template.map((row, index) => {
              const list = eligible(row.category);
              const options = list.length ? list : fillers;
              return (
                <div className="lb-template-row" key={index}>
                  <span className="lb-kind">{categoryLabels[row.category] ?? row.category}</span>
                  <select onChange={(event) => setChoices((current) => current.map((value, at) => (at === index ? event.target.value : value)))} value={choices[index]}>
                    {options.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.filename} ({lengthLabel(asset).replace("file ", "")})
                      </option>
                    ))}
                  </select>
                  <span>{formatSeconds(fitted.durations[index])}</span>
                  {list.length === 0 ? <span className="lb-fit is-held">No {categoryLabels[row.category]?.toLowerCase()} in the library: pick any filler.</span> : null}
                </div>
              );
            })}
          </>
        )}
        <div className="button-row lx-confirm-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={!fitted.ok || choices.some((choice) => !choice)}
            onClick={() => fitted.ok && onApply(choices.map((assetId, index) => ({ assetId, durationMs: fitted.durations[index] })))}
            type="button"
          >
            Replace this slot's fillers
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Plays the items as the cab will: each for exactly its time; a video longer than its time is cut,
 * a shorter one stays on its last frame (silent) until its time is up; stills show for their time.
 */
function PreviewPlayer({
  slots,
  assetMap,
  onClose,
  frame,
}: {
  slots: SlotState[];
  assetMap: Map<string, AssetOption>;
  onClose: () => void;
  frame: { width: number; height: number };
}) {
  const playlist = slots.flatMap((entry) => entry.items.map((item) => ({ ...item, position: entry.position, asset: assetMap.get(item.assetId) })));
  const [index, setIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [held, setHeld] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const current = playlist[index];

  useEffect(() => {
    if (!current) return;
    setElapsedMs(0);
    setHeld(false);
    const started = performance.now();
    const timer = window.setInterval(() => {
      const ms = performance.now() - started;
      setElapsedMs(ms);
      const video = videoRef.current;
      if (video && ms >= current.durationMs - 30) video.pause();
      if (ms >= current.durationMs) {
        window.clearInterval(timer);
        setIndex((value) => (value + 1) % playlist.length);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [current, playlist.length]);

  if (!current) {
    return (
      <Modal onClose={onClose} title="Preview">
        <p className="muted">Nothing to preview yet.</p>
      </Modal>
    );
  }
  const isImage = current.asset?.mimeType.startsWith("image/");
  const fit = fitOf(current.asset, current.durationMs);
  return (
    <Modal className="lb-preview" eyebrow={slots.length > 1 ? "Whole loop, as the cab plays it" : `Slot ${slots[0].position + 1}, as the cab plays it`} onClose={onClose} title={current.asset?.filename ?? "Preview"}>
      <div className="stack">
        <div className="lb-preview-frame" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
          {isImage ? (
            <img alt={current.asset?.filename ?? ""} src={current.asset?.previewUrl} />
          ) : (
            <video autoPlay key={`${index}-${current.key}`} onEnded={() => setHeld(true)} playsInline ref={videoRef} src={current.asset?.previewUrl} />
          )}
          {held ? <span className="lb-preview-held">Held on its last frame</span> : null}
        </div>
        <div className="lb-preview-bar">
          <span>
            Slot {current.position + 1} · {current.contentType === "ADVERTISEMENT" ? "Advert" : "Filler"} · {formatClock(elapsedMs)} of {formatClock(current.durationMs)}
            {fit.kind === "cut" ? " · cut off at its time" : ""}
          </span>
          <div className="button-row">
            <button className="button button-secondary" onClick={() => setIndex((value) => (value - 1 + playlist.length) % playlist.length)} type="button">
              Previous
            </button>
            <button className="button button-secondary" onClick={() => setIndex((value) => (value + 1) % playlist.length)} type="button">
              Next
            </button>
          </div>
        </div>
        <div className="lb-preview-track">
          <div className="lb-preview-fill" style={{ width: `${Math.min(elapsedMs / current.durationMs, 1) * 100}%` }} />
        </div>
      </div>
    </Modal>
  );
}
