"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  advertisementDurationMs,
  slotDurationMs,
  type AssetCategory,
} from "@orison/shared/src/constants";

import { MediaPoster } from "@/components/media-poster";
import { Modal } from "@/components/modal";
import { StatusPill } from "@/components/status-pill";
import { useToast } from "@/components/toast-provider";

type AssetOption = {
  id: string;
  filename: string;
  category: AssetCategory;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fileSize: number;
  thumbnailUrl: string | null;
  previewUrl: string;
  metadata: Record<string, string>;
};

type SlotContentItem = {
  id?: string;
  assetId: string;
  orderInSlot: number;
  startTimeMs: number;
  durationMs: number;
  contentType: "ADVERTISEMENT" | "FILLER";
  asset?: AssetOption;
};

type SlotItem = {
  id: string;
  position: number;
  staticCreativeId?: string | null;
  staticCreative?: AssetOption | null;
  contents: SlotContentItem[];
};

type PreviewItem = {
  assetId: string;
  filename: string;
  url: string;
  mimeType: string;
  durationMs: number;
  type: "ADVERTISEMENT" | "FILLER";
  slotPosition: number;
};

type Props = {
  loop: {
    id: string;
    name: string;
    status: string;
    slots: SlotItem[];
  };
  advertisementAssets: AssetOption[];
  staticCreativeAssets: AssetOption[];
  fillerAssets: AssetOption[];
  fillerTemplate: Array<{
    category: AssetCategory;
    durationMs: number;
  }>;
};

function formatTime(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

function assetMetaSummary(asset?: AssetOption) {
  if (!asset) {
    return "No asset selected";
  }

  const advertiser = asset.metadata.advertiserName;
  const campaign = asset.metadata.campaignName;

  if (advertiser && campaign) {
    return `${advertiser} / ${campaign}`;
  }

  return advertiser ?? campaign ?? asset.filename;
}

function withStartTimes(contents: SlotContentItem[], assetMap: Map<string, AssetOption>) {
  let current = 0;
  return contents
    .slice()
    .sort((a, b) => a.orderInSlot - b.orderInSlot)
    .map((content, index) => {
      const next = {
        ...content,
        orderInSlot: index,
        startTimeMs: current,
        asset: assetMap.get(content.assetId),
      };
      current += next.durationMs;
      return next;
    });
}

function getSlotSummary(slot: SlotItem) {
  const totalDuration = slot.contents.reduce((sum, item) => sum + item.durationMs, 0);
  const adCount = slot.contents.filter((item) => item.contentType === "ADVERTISEMENT").length;
  const isValid = totalDuration === slotDurationMs && adCount === 1;

  return {
    totalDuration,
    adCount,
    isValid,
  };
}

function buildPreviewItems(slots: SlotItem[], scope: "slot" | "loop", selectedPosition: number) {
  const visibleSlots =
    scope === "slot" ? slots.filter((slot) => slot.position === selectedPosition) : slots;

  return visibleSlots
    .slice()
    .sort((a, b) => a.position - b.position)
    .flatMap((slot) =>
      slot.contents
        .slice()
        .sort((a, b) => a.orderInSlot - b.orderInSlot)
        .map((content) => {
          if (!content.asset) {
            return null;
          }

          return {
            assetId: content.assetId,
            filename: content.asset.filename,
            url: content.asset.previewUrl,
            mimeType: content.asset.mimeType,
            durationMs: content.durationMs,
            type: content.contentType,
            slotPosition: slot.position,
          } satisfies PreviewItem;
        })
        .filter((item): item is PreviewItem => Boolean(item)),
    );
}

export function LoopBuilder({
  loop,
  advertisementAssets,
  staticCreativeAssets,
  fillerAssets,
  fillerTemplate,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const allAssets = useMemo(
    () => [...advertisementAssets, ...fillerAssets],
    [advertisementAssets, fillerAssets],
  );
  const assetMap = useMemo(
    () => new Map(allAssets.map((asset) => [asset.id, asset])),
    [allAssets],
  );
  const [name, setName] = useState(loop.name);
  const [status, setStatus] = useState(loop.status);
  const [slots, setSlots] = useState(() =>
    loop.slots.map((slot) => ({
      ...slot,
      contents: withStartTimes(slot.contents, assetMap),
    })),
  );
  const [selectedPosition, setSelectedPosition] = useState(0);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirtySlots, setDirtySlots] = useState<number[]>([]);
  const [dirtyName, setDirtyName] = useState(false);
  const [adPickerOpen, setAdPickerOpen] = useState(false);
  const [staticPickerOpen, setStaticPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewScope, setPreviewScope] = useState<"slot" | "loop">("slot");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const selectedSlot =
    slots.find((slot) => slot.position === selectedPosition) ??
    slots.slice().sort((a, b) => a.position - b.position)[0];
  const selectedAd = selectedSlot?.contents.find((item) => item.contentType === "ADVERTISEMENT");
  const selectedStaticCreative = selectedSlot?.staticCreative ?? null;
  const selectedFillers = selectedSlot?.contents.filter((item) => item.contentType === "FILLER") ?? [];
  const previewItems = useMemo(
    () => buildPreviewItems(slots, previewScope, selectedPosition),
    [previewScope, selectedPosition, slots],
  );
  const currentPreview = previewItems[previewIndex];
  const validSlotCount = slots.filter((slot) => getSlotSummary(slot).isValid).length;

  useEffect(() => {
    if (!previewOpen || !currentPreview || !currentPreview.mimeType.startsWith("image/")) {
      return;
    }

    const timer = window.setTimeout(() => {
      setPreviewIndex((index) => (index + 1) % previewItems.length);
    }, currentPreview.durationMs);

    return () => window.clearTimeout(timer);
  }, [currentPreview, previewItems.length, previewOpen]);

  function markSlotDirty(position: number) {
    setDirtySlots((current) =>
      current.includes(position) ? current : [...current, position].sort((a, b) => a - b),
    );
  }

  function replaceSelectedSlot(contents: SlotContentItem[]) {
    if (!selectedSlot) {
      return;
    }

    setSlots((current) =>
      current.map((slot) =>
        slot.position === selectedPosition
          ? {
              ...slot,
              contents: withStartTimes(contents, assetMap),
            }
          : slot,
      ),
    );
    markSlotDirty(selectedPosition);
  }

  function chooseAd(asset: AssetOption) {
    const fillers = selectedFillers.map((content) => ({
      ...content,
      asset: assetMap.get(content.assetId),
    }));

    replaceSelectedSlot([
      {
        assetId: asset.id,
        orderInSlot: 0,
        startTimeMs: 0,
        durationMs: advertisementDurationMs,
        contentType: "ADVERTISEMENT",
        asset,
      },
      ...fillers,
    ]);
    setAdPickerOpen(false);
    setError(null);
  }

  function chooseStaticCreative(asset: AssetOption | null) {
    if (!selectedSlot) {
      return;
    }

    setSlots((current) =>
      current.map((slot) =>
        slot.position === selectedPosition
          ? {
              ...slot,
              staticCreativeId: asset?.id ?? null,
              staticCreative: asset,
            }
          : slot,
      ),
    );
    markSlotDirty(selectedPosition);
    setStaticPickerOpen(false);
    setError(null);
  }

  function handleAutofill() {
    if (!selectedAd) {
      setError("Choose an advertisement before auto-filling the remaining 48 seconds.");
      toast({
        title: "Advertisement required",
        message: "Choose an ad before using the filler template.",
        tone: "error",
      });
      return;
    }

    const fillerContents: SlotContentItem[] = [];

    for (const [index, templateItem] of fillerTemplate.entries()) {
      const asset = fillerAssets.find((entry) => entry.category === templateItem.category);

      if (!asset) {
        const message = `No ready ${templateItem.category} asset is available for the filler template.`;
        setError(message);
        toast({
          title: "Filler template incomplete",
          message,
          tone: "error",
        });
        return;
      }

      fillerContents.push({
        assetId: asset.id,
        orderInSlot: index + 1,
        startTimeMs: 0,
        durationMs: templateItem.durationMs,
        contentType: "FILLER",
        asset,
      });
    }

    replaceSelectedSlot([{ ...selectedAd, asset: selectedAd.asset }, ...fillerContents]);
    toast({
      title: `Slot ${selectedPosition + 1} filler applied`,
      message: "Weather, news, and branded segments were added from settings.",
      tone: "success",
    });
  }

  function handleFillerChange(index: number, assetId: string) {
    const nextFillers = selectedFillers.map((content, fillerIndex) =>
      fillerIndex === index
        ? {
            ...content,
            assetId,
            asset: assetMap.get(assetId),
          }
        : content,
    );

    replaceSelectedSlot([...(selectedAd ? [{ ...selectedAd, asset: selectedAd.asset }] : []), ...nextFillers]);
  }

  function handleDurationChange(index: number, durationMs: number) {
    const nextFillers = selectedFillers.map((content, fillerIndex) =>
      fillerIndex === index
        ? {
            ...content,
            durationMs: Number.isFinite(durationMs) ? Math.max(durationMs, 1000) : content.durationMs,
          }
        : content,
    );

    replaceSelectedSlot([...(selectedAd ? [{ ...selectedAd, asset: selectedAd.asset }] : []), ...nextFillers]);
  }

  async function saveLoopName() {
    if (!dirtyName) {
      return true;
    }

    const response = await fetch(`/api/loops/${loop.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Unable to save loop name");
    }

    setDirtyName(false);
    return true;
  }

  async function saveDirtySlots() {
    for (const position of dirtySlots) {
      const slot = slots.find((item) => item.position === position);

      if (!slot) {
        continue;
      }

      const response = await fetch(`/api/loops/${loop.id}/slots/${position}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: slot.contents.map((content) => ({
            assetId: content.assetId,
            orderInSlot: content.orderInSlot,
            startTimeMs: content.startTimeMs,
            durationMs: content.durationMs,
            contentType: content.contentType,
          })),
          staticCreativeId: slot.staticCreativeId ?? null,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Unable to save slot ${position + 1}`);
      }
    }

    setDirtySlots([]);
  }

  async function persistChanges(options?: { silent?: boolean }) {
    if (!dirtyName && dirtySlots.length === 0) {
      return true;
    }

    setSaving(true);
    setError(null);

    try {
      await saveLoopName();
      await saveDirtySlots();

      if (!options?.silent) {
        toast({
          title: "Loop changes saved",
          message: `Saved ${dirtySlots.length || 0} slot changes and updated loop details.`,
          tone: "success",
        });
      }

      return true;
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Unable to save loop changes";
      setError(message);
      toast({
        title: "Save failed",
        message,
        tone: "error",
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function publishLoop() {
    const invalidSlot = slots.find((slot) => !getSlotSummary(slot).isValid);
    if (invalidSlot) {
      setSelectedPosition(invalidSlot.position);
      const message = `Slot ${invalidSlot.position + 1} must contain one 12 second ad and total 60 seconds.`;
      setError(message);
      toast({
        title: "Loop is incomplete",
        message,
        tone: "error",
      });
      return;
    }

    const confirmed = window.confirm(
      "This will compile the latest loop and push it to all active cab devices. Continue?",
    );
    if (!confirmed) {
      return;
    }

    const saved = await persistChanges({ silent: true });
    if (!saved) {
      return;
    }

    setPublishing(true);
    setError(null);

    try {
      const response = await fetch(`/api/loops/${loop.id}/publish`, {
        method: "POST",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to publish loop");
      }

      setStatus("PUBLISHED");
      toast({
        title: "Loop published",
        message: "The loop manifest and compiled MP4 were generated successfully.",
        tone: "success",
      });
      router.refresh();
    } catch (publishError) {
      const message =
        publishError instanceof Error ? publishError.message : "Unable to publish loop";
      setError(message);
      toast({
        title: "Publish failed",
        message,
        tone: "error",
      });
    } finally {
      setPublishing(false);
    }
  }

  async function deleteLoop() {
    const confirmed = window.confirm(`Delete loop "${name}"?`);
    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/loops/${loop.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to delete loop");
      }

      toast({
        title: "Loop deleted",
        message: `${name} was removed.`,
        tone: "success",
      });
      router.push("/loops");
      router.refresh();
    } catch (deleteError) {
      const message =
        deleteError instanceof Error ? deleteError.message : "Unable to delete loop";
      setError(message);
      toast({
        title: "Delete failed",
        message,
        tone: "error",
      });
    } finally {
      setDeleting(false);
    }
  }

  async function archiveLoop() {
    const confirmed = window.confirm(`Pause published loop "${name}"?`);
    if (!confirmed) {
      return;
    }

    setArchiving(true);
    setError(null);

    try {
      const response = await fetch(`/api/loops/${loop.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "ARCHIVED" }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to pause loop");
      }

      setStatus("ARCHIVED");
      toast({
        title: "Loop paused",
        message: `${name} was archived and is no longer active.`,
        tone: "success",
      });
      router.refresh();
    } catch (archiveError) {
      const message =
        archiveError instanceof Error ? archiveError.message : "Unable to pause loop";
      setError(message);
      toast({
        title: "Pause failed",
        message,
        tone: "error",
      });
    } finally {
      setArchiving(false);
    }
  }

  function openPreview(scope: "slot" | "loop") {
    const items = buildPreviewItems(slots, scope, selectedPosition);
    if (items.length === 0) {
      const message =
        scope === "slot"
          ? "The selected slot has no playable media yet."
          : "Add content to the loop before previewing it.";
      setError(message);
      toast({
        title: "Nothing to preview",
        message,
        tone: "error",
      });
      return;
    }

    setPreviewScope(scope);
    setPreviewIndex(0);
    setPreviewOpen(true);
  }

  if (!selectedSlot) {
    return null;
  }

  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="loop-builder-header">
          <div className="stack-sm">
            <span className="eyebrow">Loop Builder</span>
            <div className="loop-title-row">
              <input
                className="loop-name-input"
                onChange={(event) => {
                  setName(event.target.value);
                  setDirtyName(true);
                }}
                value={name}
              />
              <StatusPill value={status} />
            </div>
            <div className="muted">
              {validSlotCount}/10 slots ready. Each slot needs one 12 second ad and 48 seconds of filler.
            </div>
          </div>
          <div className="button-row">
            {status === "PUBLISHED" ? (
              <button
                className="button button-secondary"
                disabled={saving || publishing || deleting || archiving}
                onClick={() => void archiveLoop()}
                type="button"
              >
                {archiving ? "Pausing..." : "Pause"}
              </button>
            ) : null}
            {status !== "PUBLISHED" ? (
              <button
                className="button button-danger"
                disabled={saving || publishing || deleting || archiving}
                onClick={() => void deleteLoop()}
                type="button"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            ) : null}
            <button
              className="button button-secondary"
              disabled={saving || publishing || archiving || (!dirtyName && dirtySlots.length === 0)}
              onClick={() => void persistChanges()}
              type="button"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
            <button
              className="button button-secondary"
              onClick={() => openPreview("slot")}
              type="button"
            >
              Preview
            </button>
            <button
              className="button button-primary"
              disabled={saving || publishing || archiving}
              onClick={() => void publishLoop()}
              type="button"
            >
              {publishing ? "Publishing..." : "Publish"}
            </button>
          </div>
        </div>
        {error ? <div className="alert alert-danger">{error}</div> : null}
      </div>

      <section className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Timeline</span>
            <h2>Ten Slot Programme</h2>
          </div>
          <div className="button-row">
            <button
              className="button button-secondary"
              onClick={() => openPreview("loop")}
              type="button"
            >
              Preview Full Loop
            </button>
          </div>
        </div>

        <div className="timeline-scroll">
          <div className="timeline-track">
            {slots
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((slot) => {
                const summary = getSlotSummary(slot);
                const slotAd = slot.contents.find((content) => content.contentType === "ADVERTISEMENT");
                const isActive = slot.position === selectedPosition;

                return (
                  <button
                    className={`timeline-slot ${isActive ? "is-active" : ""}`}
                    key={slot.id}
                    onClick={() => setSelectedPosition(slot.position)}
                    type="button"
                  >
                    <div className="timeline-slot-header">
                      <div>
                        <span className="eyebrow">Slot {slot.position + 1}</span>
                        <strong>{slotAd?.asset?.filename ?? "Choose advertisement"}</strong>
                      </div>
                      <span
                        className={`timeline-status ${summary.isValid ? "is-valid" : "is-invalid"}`}
                      >
                        {summary.isValid ? "OK" : "!"}
                      </span>
                    </div>

                    <MediaPoster
                      alt={slotAd?.asset?.filename ?? `Slot ${slot.position + 1}`}
                      className="timeline-poster"
                      label="No ad assigned"
                      src={slotAd?.asset?.thumbnailUrl}
                    />

                    <div className="slot-bar">
                      {slot.contents.length > 0 ? (
                        slot.contents.map((content) => (
                          <span
                            className={
                              content.contentType === "ADVERTISEMENT"
                                ? "segment segment-ad"
                                : "segment segment-filler"
                            }
                            key={`${slot.id}-${content.orderInSlot}-${content.assetId}`}
                            style={{ width: `${(content.durationMs / slotDurationMs) * 100}%` }}
                          />
                        ))
                      ) : (
                        <span className="segment segment-empty" style={{ width: "100%" }} />
                      )}
                    </div>

                    <div className="timeline-slot-meta">
                      <span>{formatTime(summary.totalDuration)} programmed</span>
                      <span>{summary.isValid ? "Ready to publish" : "Needs work"}</span>
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      </section>

      <section className="card stack-lg">
        <div className="card-header">
          <div>
            <span className="eyebrow">Selected Slot</span>
            <h2>Slot {selectedPosition + 1} detail</h2>
          </div>
          <div className="button-row">
            <button className="button button-secondary" onClick={handleAutofill} type="button">
              Auto-fill filler
            </button>
          </div>
        </div>

        <div className="selected-slot-timeline">
          <div className="slot-bar slot-bar-large">
            {selectedSlot.contents.length > 0 ? (
              selectedSlot.contents.map((content) => (
                <span
                  className={
                    content.contentType === "ADVERTISEMENT"
                      ? "segment segment-ad"
                      : "segment segment-filler"
                  }
                  key={`${selectedSlot.id}-${content.orderInSlot}-${content.assetId}`}
                  style={{ width: `${(content.durationMs / slotDurationMs) * 100}%` }}
                />
              ))
            ) : (
              <span className="segment segment-empty" style={{ width: "100%" }} />
            )}
          </div>
          <div className="timeline-legend">
            {selectedSlot.contents.map((content) => (
              <span className="timeline-legend-item" key={`${content.orderInSlot}-${content.assetId}`}>
                <strong>{content.contentType === "ADVERTISEMENT" ? "Ad" : "Filler"}</strong>
                <span>
                  {formatTime(content.startTimeMs)} - {formatTime(content.startTimeMs + content.durationMs)}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div className="slot-detail-grid">
          <div className="segment-panel segment-panel-ad">
            <div className="segment-panel-header">
              <div>
                <span className="eyebrow">Advertisement</span>
                <strong>{selectedAd?.asset?.filename ?? "No advertisement selected"}</strong>
              </div>
              <div className="segment-panel-meta">12 seconds</div>
            </div>

            <div className="segment-panel-body">
              <MediaPoster
                alt={selectedAd?.asset?.filename ?? "Advertisement slot"}
                className="segment-poster"
                label="Choose an ad"
                src={selectedAd?.asset?.thumbnailUrl}
              />
              <div className="segment-panel-copy">
                <strong>{assetMetaSummary(selectedAd?.asset)}</strong>
                <p className="muted">
                  This slot always begins with the 12 second advertisement segment.
                </p>
                <button
                  className="button button-primary"
                  disabled={advertisementAssets.length === 0}
                  onClick={() => setAdPickerOpen(true)}
                  type="button"
                >
                  Choose Ad
                </button>
              </div>
            </div>
          </div>

          <div className="segment-panel">
            <div className="segment-panel-header">
              <div>
                <span className="eyebrow">Static Creative</span>
                <strong>{selectedStaticCreative?.filename ?? "No static creative selected"}</strong>
              </div>
              <div className="segment-panel-meta">Silent mode image</div>
            </div>

            <div className="segment-panel-body">
              <MediaPoster
                alt={selectedStaticCreative?.filename ?? "Static creative slot"}
                className="segment-poster"
                label="Choose a static creative"
                src={selectedStaticCreative?.thumbnailUrl ?? selectedStaticCreative?.previewUrl ?? null}
              />
              <div className="segment-panel-copy">
                <strong>{assetMetaSummary(selectedStaticCreative ?? undefined)}</strong>
                <p className="muted">
                  This image is shown during silent mode for the current minute slot.
                </p>
                <div className="button-row">
                  <button
                    className="button button-secondary"
                    disabled={staticCreativeAssets.length === 0}
                    onClick={() => setStaticPickerOpen(true)}
                    type="button"
                  >
                    Choose Static Creative
                  </button>
                  {selectedStaticCreative ? (
                    <button
                      className="button button-secondary"
                      onClick={() => chooseStaticCreative(null)}
                      type="button"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="segment-panel">
            <div className="segment-panel-header">
              <div>
                <span className="eyebrow">Filler Segments</span>
                <strong>{selectedFillers.length} configured</strong>
              </div>
              <div className="segment-panel-meta">Target 48 seconds</div>
            </div>

            <div className="segment-list">
              {selectedFillers.length === 0 ? (
                <div className="empty-state compact">
                  <strong>No filler segments yet</strong>
                  <p>Use the default weather, news, and branded template to complete this slot.</p>
                </div>
              ) : (
                selectedFillers.map((content, index) => (
                  <div className="segment-list-item" key={`${content.assetId}-${index}`}>
                    <MediaPoster
                      alt={content.asset?.filename ?? `Filler ${index + 1}`}
                      className="segment-thumb"
                      label="Filler"
                      src={content.asset?.thumbnailUrl}
                    />
                    <div className="segment-copy">
                      <strong>{content.asset?.filename ?? "Choose filler asset"}</strong>
                      <span className="muted">
                        {formatTime(content.startTimeMs)} start / {content.asset?.category ?? "FILLER"}
                      </span>
                    </div>
                    <select
                      onChange={(event) => handleFillerChange(index, event.target.value)}
                      value={content.assetId}
                    >
                      {fillerAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.category} / {asset.filename}
                        </option>
                      ))}
                    </select>
                    <label className="field compact-field">
                      <span>Duration</span>
                      <input
                        min={1000}
                        onChange={(event) => handleDurationChange(index, Number(event.target.value))}
                        step={1000}
                        type="number"
                        value={content.durationMs}
                      />
                    </label>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="validation-banner">
          <div className={`validation-state ${getSlotSummary(selectedSlot).isValid ? "is-valid" : "is-invalid"}`}>
            <strong>
              {getSlotSummary(selectedSlot).isValid ? "Slot ready" : "Slot incomplete"}
            </strong>
            <span>
              {getSlotSummary(selectedSlot).isValid
                ? "This slot totals 60 seconds and contains one advertisement."
                : "The slot must total exactly 60 seconds with one 12 second advertisement."}
            </span>
          </div>
          <button
            className="button button-secondary"
            disabled={saving || publishing || !dirtySlots.includes(selectedPosition)}
            onClick={() => void persistChanges()}
            type="button"
          >
            Save selected slot
          </button>
        </div>
      </section>

      {adPickerOpen ? (
        <Modal
          eyebrow="Advertisement Assets"
          onClose={() => setAdPickerOpen(false)}
          title={`Choose ad for slot ${selectedPosition + 1}`}
        >
          <div className="asset-picker-grid">
            {advertisementAssets.length === 0 ? (
              <div className="empty-state compact">
                <strong>No advertisement assets ready</strong>
                <p>Upload and process ad creatives in the asset library first.</p>
              </div>
            ) : (
              advertisementAssets.map((asset) => (
                <button
                  className={`asset-choice ${selectedAd?.assetId === asset.id ? "is-selected" : ""}`}
                  key={asset.id}
                  onClick={() => chooseAd(asset)}
                  type="button"
                >
                  <MediaPoster
                    alt={asset.filename}
                    className="asset-choice-poster"
                    label="Ad creative"
                    src={asset.thumbnailUrl}
                  />
                  <div className="stack-sm">
                    <strong>{asset.filename}</strong>
                    <span className="muted">{assetMetaSummary(asset)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {staticPickerOpen ? (
        <Modal
          eyebrow="Static Creatives"
          onClose={() => setStaticPickerOpen(false)}
          title={`Choose static creative for slot ${selectedPosition + 1}`}
        >
          <div className="asset-picker-grid">
            {staticCreativeAssets.length === 0 ? (
              <div className="empty-state compact">
                <strong>No static creative assets ready</strong>
                <p>Upload branded JPG or PNG static creatives in the asset library first.</p>
              </div>
            ) : (
              staticCreativeAssets.map((asset) => (
                <button
                  className={`asset-choice ${
                    selectedStaticCreative?.id === asset.id ? "is-selected" : ""
                  }`}
                  key={asset.id}
                  onClick={() => chooseStaticCreative(asset)}
                  type="button"
                >
                  <MediaPoster
                    alt={asset.filename}
                    className="asset-choice-poster"
                    label="Static creative"
                    src={asset.thumbnailUrl ?? asset.previewUrl}
                  />
                  <div className="stack-sm">
                    <strong>{asset.filename}</strong>
                    <span className="muted">{assetMetaSummary(asset)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {previewOpen ? (
        <Modal
          className="preview-modal"
          eyebrow="Preview"
          onClose={() => setPreviewOpen(false)}
          title={previewScope === "slot" ? `Slot ${selectedPosition + 1}` : "Full Loop"}
        >
          <div className="preview-controls">
            <div className="segmented-control">
              <button
                className={`segment-toggle ${previewScope === "slot" ? "is-active" : ""}`}
                onClick={() => {
                  setPreviewScope("slot");
                  setPreviewIndex(0);
                }}
                type="button"
              >
                Selected Slot
              </button>
              <button
                className={`segment-toggle ${previewScope === "loop" ? "is-active" : ""}`}
                onClick={() => {
                  setPreviewScope("loop");
                  setPreviewIndex(0);
                }}
                type="button"
              >
                Full Loop
              </button>
            </div>
            <span className="muted">
              Item {previewIndex + 1} of {previewItems.length}
            </span>
          </div>

          <div className="preview-frame">
            {currentPreview?.mimeType.startsWith("image/") ? (
              <img alt={currentPreview.filename} src={currentPreview.url} />
            ) : (
              <video
                autoPlay
                controls
                key={currentPreview?.url}
                onEnded={() => setPreviewIndex((index) => (index + 1) % previewItems.length)}
                src={currentPreview?.url}
              />
            )}
          </div>

          <div className="preview-playlist">
            {previewItems.map((item, index) => (
              <button
                className={`preview-playlist-item ${index === previewIndex ? "is-active" : ""}`}
                key={`${item.slotPosition}-${item.assetId}-${index}`}
                onClick={() => setPreviewIndex(index)}
                type="button"
              >
                <span className="eyebrow">Slot {item.slotPosition + 1}</span>
                <strong>{item.filename}</strong>
                <span className="muted">
                  {item.type} / {formatTime(item.durationMs)}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
