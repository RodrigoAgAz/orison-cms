"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { MediaPoster } from "@/components/media-poster";
import { Modal } from "@/components/modal";
import { PaginationControls } from "@/components/pagination-controls";
import { useToast } from "@/components/toast-provider";
import { fileFingerprint, sendFileInPieces, UploadCancelled, UploadRefused } from "@/lib/piece-sender";

type AssetItem = {
  id: string;
  filename: string;
  category: string;
  status: string;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fileSize: number;
  thumbnailUrl: string | null;
  previewUrl: string;
  metadata: Record<string, string>;
  createdAt: string;
  errorMessage: string | null;
  isSafetyMessage: boolean;
  slotUsages: Array<{
    usageType: "VIDEO" | "STATIC";
    slot: {
      position: number;
      loop: {
        id: string;
        name: string;
        status: string;
      };
    };
  }>;
};

type Props = {
  assets: AssetItem[];
  page: number;
  pageSize: number;
  total: number;
  currentQuery: string;
  currentCategory: string;
};

const categories = [
  "ALL",
  "ADVERTISEMENT",
  "STATIC_CREATIVE",
  "SAFETY_MESSAGE",
  "FILLER_WEATHER",
  "FILLER_NEWS",
  "FILLER_BRANDED",
  "FILLER_OTHER",
] as const;

export const categoryLabels: Record<string, string> = {
  ALL: "All kinds",
  ADVERTISEMENT: "Advert",
  STATIC_CREATIVE: "Still image (between journeys)",
  SAFETY_MESSAGE: "Safety message",
  FILLER_WEATHER: "Weather filler",
  FILLER_NEWS: "News filler",
  FILLER_BRANDED: "Branded filler",
  FILLER_OTHER: "Other filler",
};

const statusLabels: Record<string, { label: string; className: string }> = {
  READY: { label: "Ready", className: "pill pill-success" },
  PROCESSING: { label: "Processing", className: "pill pill-warning" },
  FAILED: { label: "Failed", className: "pill pill-danger" },
};

function lengthOf(asset: { mimeType: string; durationMs: number | null; status: string }) {
  if (asset.mimeType.startsWith("image/")) return "Still image";
  if (asset.status !== "READY" || !asset.durationMs) return "—";
  return `${(Math.round(asset.durationMs / 100) / 10).toFixed(1)} s`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1000)} KB`;
  }

  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function assetSummary(asset: AssetItem) {
  const advertiser = asset.metadata.advertiserName;
  const campaign = asset.metadata.campaignName;

  if (advertiser && campaign) {
    return `${advertiser} / ${campaign}`;
  }

  return advertiser ?? campaign ?? "No advertiser or campaign";
}

export function AssetLibrary({
  assets,
  page,
  pageSize,
  total,
  currentQuery,
  currentCategory,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>(currentCategory || "ALL");
  const [query, setQuery] = useState(currentQuery);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [category, setCategory] = useState("ADVERTISEMENT");
  const [advertiserName, setAdvertiserName] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<AssetItem | null>(null);
  const processingIds = assets.filter((asset) => asset.status === "PROCESSING").map((asset) => asset.id).join(",");
  useEffect(() => {
    // Files are processed in the background: refresh until they are ready (or failed).
    if (!processingIds) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [processingIds, router]);
  const [uploadState, setUploadState] = useState<{
    phase: "idle" | "uploading" | "finishing";
    progress: number;
  }>({
    phase: "idle",
    progress: 0,
  });

  function handleFileSelect(file: File | null) {
    setSelectedFile(file);
    setError(null);
  }

  function resetForm() {
    setSelectedFile(null);
    setAdvertiserName("");
    setCampaignName("");
    setCategory("ADVERTISEMENT");
    setUploadState({
      phase: "idle",
      progress: 0,
    });
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();

    if (query.trim()) {
      params.set("search", query.trim());
    }

    if (selectedCategory !== "ALL") {
      params.set("category", selectedCategory);
    }

    router.push(params.toString() ? `/assets?${params.toString()}` : "/assets");
  }

  function clearFilters() {
    setQuery("");
    setSelectedCategory("ALL");
    router.push("/assets");
  }

  async function uploadFile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFile) {
      setError("Choose a file to upload.");
      return;
    }
    const file = selectedFile;
    setError(null);
    setUploadState({ phase: "uploading", progress: 0 });
    const controller = new AbortController();
    abortRef.current = controller;
    uploadIdRef.current = null;
    try {
      // In pieces of a few MB (lib/piece-sender.ts): the hosting proxy cuts off any request whose
      // body takes more than 5 minutes, and a dropped connection only pauses the upload.
      const result = await sendFileInPieces({
        baseUrl: "/api/uploads",
        open: {
          kind: "asset",
          category,
          metadata: { advertiserName: advertiserName.trim(), campaignName: campaignName.trim() },
        },
        file,
        fileName: file.name,
        fingerprint: await fileFingerprint(file),
        signal: controller.signal,
        events: {
          onSession: (session) => {
            uploadIdRef.current = session.uploadId;
            setUploadState({ phase: "uploading", progress: Math.floor((session.receivedBytes / file.size) * 100) });
          },
          onProgress: ({ confirmedBytes }) => setUploadState({ phase: "uploading", progress: Math.floor((confirmedBytes / file.size) * 100) }),
          onConnection: (state) => setWaiting(state === "waiting"),
          onFinishing: () => setUploadState({ phase: "finishing", progress: 100 }),
        },
      });
      toast({
        title: "Uploaded",
        message: `${typeof result.filename === "string" ? result.filename : file.name} is being processed; it shows as Ready when it can be used.`,
        tone: "success",
      });
      resetForm();
      router.refresh();
    } catch (failure) {
      setUploadState({ phase: "idle", progress: 0 });
      if (failure instanceof UploadCancelled) {
        // Delete the pieces already sent (otherwise kept a day so the same file can carry on).
        if (uploadIdRef.current) void fetch(`/api/uploads/${uploadIdRef.current}`, { method: "DELETE" }).catch(() => undefined);
        toast({ title: "Upload cancelled", message: "Nothing was saved.", tone: "info" });
        return;
      }
      const message = failure instanceof UploadRefused ? failure.message : "The upload failed. Try again.";
      setError(message);
      toast({ title: "Upload failed", message, tone: "error" });
    } finally {
      abortRef.current = null;
      setWaiting(false);
    }
  }

  async function handleDelete(asset: AssetItem) {
    const used = new Set(asset.slotUsages.map((usage) => usage.slot.loop.name));
    const confirmed = window.confirm(
      used.size
        ? `Remove "${asset.filename}" from the library? ${used.size === 1 ? "A loop uses" : `${used.size} loops use`} it, so its file is kept for ${used.size === 1 ? "that loop" : "them"} and it is only hidden here.`
        : `Delete "${asset.filename}"? Nothing uses it, so it is deleted for good.`,
    );
    if (!confirmed) {
      return;
    }
    const assetId = asset.id;

    const response = await fetch(`/api/assets/${assetId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      const message = body?.error ?? "The file could not be removed.";
      toast({
        title: "Not removed",
        message,
        tone: "error",
      });
      return;
    }

    const outcome = (await response.json().catch(() => null)) as { outcome?: string; message?: string } | null;
    toast({
      title: outcome?.outcome === "hidden" ? "Removed from the library" : "Deleted",
      message: outcome?.message ?? "Done.",
      tone: "success",
    });
    setSelectedAsset(null);
    router.refresh();
  }

  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Upload</span>
            <h2>Add a file</h2>
          </div>
        </div>

        <form className="asset-upload-stack" onSubmit={uploadFile}>
          <button
            className={`drop-zone ${dragActive ? "is-dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              handleFileSelect(event.dataTransfer.files.item(0));
            }}
            type="button"
          >
            <input
              accept=".mp4,.mov,.m4v,.webm,.jpg,.jpeg,.png,.webp"
              hidden
              name="file"
              onChange={(event) => handleFileSelect(event.target.files?.item(0) ?? null)}
              ref={inputRef}
              type="file"
            />
            <span className="drop-zone-kicker">Drag files here or click to browse</span>
            <strong>{selectedFile?.name ?? "Videos: MP4, MOV (iPhone HDR is fine), WebM · Images: JPG, PNG"}</strong>
            <span className="muted">
              {selectedFile
                ? `${formatFileSize(selectedFile.size)} ready to upload`
                : "Each file is converted after upload; it can be used in loops once it shows Ready."}
            </span>
          </button>

          <div className="asset-upload-grid">
            <label className="field">
              <span>Kind</span>
              <select onChange={(event) => setCategory(event.target.value)} value={category}>
                {categories
                  .filter((item) => item !== "ALL")
                  .map((item) => (
                    <option key={item} value={item}>
                      {categoryLabels[item]}
                    </option>
                  ))}
              </select>
            </label>

            <label className="field">
              <span>Advertiser</span>
              <input
                onChange={(event) => setAdvertiserName(event.target.value)}
                placeholder="Nike, Pret, TfL..."
                value={advertiserName}
              />
            </label>

            <label className="field">
              <span>Campaign</span>
              <input
                onChange={(event) => setCampaignName(event.target.value)}
                placeholder="Spring Launch 2026"
                value={campaignName}
              />
            </label>
          </div>

          {uploadState.phase !== "idle" ? (
            <div className="upload-progress-card">
              <div className="card-header">
                <strong>
                  {uploadState.phase === "uploading" ? (waiting ? "Waiting for the connection" : "Uploading") : "Finishing the upload"}
                </strong>
                <span>{uploadState.progress}%</span>
              </div>
              <div className="progress-track">
                <span className="progress-fill" style={{ width: `${uploadState.progress}%` }} />
              </div>
              <span className="muted">
                {waiting
                  ? "The connection dropped. The upload carries on by itself when it is back."
                  : "Keep this page open until the upload finishes. If it is closed, choose the same file again to carry on."}
              </span>
              {uploadState.phase === "uploading" ? (
                <div className="button-row">
                  <button className="button button-secondary" onClick={() => abortRef.current?.abort()} type="button">
                    Cancel upload
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="alert alert-danger">{error}</div> : null}

          <div className="button-row">
            <button
              className="button button-primary"
              disabled={!selectedFile || uploadState.phase !== "idle"}
              type="submit"
            >
              {uploadState.phase === "idle" ? (
                "Upload"
              ) : (
                <span className="button-inline">
                  <span aria-hidden className="button-spinner" />
                  Uploading
                </span>
              )}
            </button>
          </div>
        </form>
      </div>

      <form className="toolbar" onSubmit={applyFilters}>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by file name, advertiser or campaign"
          value={query}
        />
        <select onChange={(event) => setSelectedCategory(event.target.value)} value={selectedCategory}>
          {categories.map((item) => (
            <option key={item} value={item}>
              {categoryLabels[item]}
            </option>
          ))}
        </select>
        <div className="button-row">
          <button className="button button-secondary" type="submit">
            Search
          </button>
          {(currentQuery || currentCategory !== "ALL") && (
            <button className="button button-secondary" onClick={clearFilters} type="button">
              Reset
            </button>
          )}
        </div>
      </form>

      {assets.length === 0 ? (
        <div className="empty-state">
          <strong>
            {currentQuery || currentCategory !== "ALL"
              ? "Nothing matches this search"
              : "No files yet"}
          </strong>
          <p>
            {currentQuery || currentCategory !== "ALL"
              ? "Try another search, or show all kinds."
              : "Upload adverts, fillers and still images to build loops with."}
          </p>
          <div className="button-row">
            {currentQuery || currentCategory !== "ALL" ? (
              <button className="button button-secondary" onClick={clearFilters} type="button">
                Show everything
              </button>
            ) : (
              <button
                className="button button-primary"
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                Upload a file
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => (
            <button
              className="card asset-card asset-card-button"
              key={asset.id}
              onClick={() => setSelectedAsset(asset)}
              type="button"
            >
              <MediaPoster
                alt={asset.filename}
                className="asset-preview"
                label={asset.status === "PROCESSING" ? "Processing…" : asset.status === "FAILED" ? "Not available" : "No preview"}
                src={asset.thumbnailUrl}
                videoSrc={asset.status === "READY" && asset.mimeType.startsWith("video/") ? asset.previewUrl : null}
              />

              <div className="stack-sm">
                <div className="card-header">
                  <strong>{asset.filename}</strong>
                  <span className={statusLabels[asset.status]?.className ?? "pill pill-muted"}>{statusLabels[asset.status]?.label ?? asset.status}</span>
                </div>

                <span className="muted">{assetSummary(asset)}</span>
                {asset.status === "FAILED" && asset.errorMessage ? <span className="asset-error">{asset.errorMessage}</span> : null}

                <div className="meta-grid">
                  <span>Kind</span>
                  <span>{categoryLabels[asset.category] ?? asset.category}{asset.isSafetyMessage ? " (in use)" : ""}</span>
                  <span>Length</span>
                  <span>{lengthOf(asset)}</span>
                  <span>Dimensions</span>
                  <span>
                    {asset.width && asset.height ? `${asset.width}×${asset.height}` : "n/a"}
                  </span>
                  <span>Size</span>
                  <span>{formatFileSize(asset.fileSize)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <PaginationControls
        page={page}
        pageSize={pageSize}
        pathname="/assets"
        query={{
          search: currentQuery || undefined,
          category: currentCategory !== "ALL" ? currentCategory : undefined,
        }}
        total={total}
      />

      {selectedAsset ? (
        <Modal
          className="asset-modal"
          eyebrow={categoryLabels[selectedAsset.category] ?? "File"}
          onClose={() => setSelectedAsset(null)}
          title={selectedAsset.filename}
        >
          <div className="asset-modal-grid">
            <div className="stack">
              <div className="preview-frame">
                {selectedAsset.mimeType.startsWith("image/") ? (
                  <img alt={selectedAsset.filename} src={selectedAsset.previewUrl} />
                ) : (
                  <video controls src={selectedAsset.previewUrl} />
                )}
              </div>
              <div className="button-row">
                <a
                  className="button button-secondary"
                  href={selectedAsset.previewUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open file
                </a>
                <button
                  className="button button-danger"
                  disabled={selectedAsset.isSafetyMessage || selectedAsset.status === "PROCESSING"}
                  onClick={() => void handleDelete(selectedAsset)}
                  title={selectedAsset.isSafetyMessage ? "This is the safety message chosen in Settings. Choose another one first." : undefined}
                  type="button"
                >
                  {selectedAsset.slotUsages.length ? "Remove from library" : "Delete"}
                </button>
              </div>
              {selectedAsset.isSafetyMessage ? (
                <p className="muted">This is the safety message chosen in Settings, so it cannot be removed until another one is chosen.</p>
              ) : null}
              {selectedAsset.status === "FAILED" ? <div className="alert alert-danger">{selectedAsset.errorMessage ?? "Processing failed."}</div> : null}
            </div>

            <div className="stack">
              <div className="card stack-sm asset-modal-card">
                <span className="eyebrow">Details</span>
                <div className="meta-grid">
                  <span>Advertiser</span>
                  <span>{selectedAsset.metadata.advertiserName ?? "—"}</span>
                  <span>Campaign</span>
                  <span>{selectedAsset.metadata.campaignName ?? "—"}</span>
                  <span>Status</span>
                  <span>{statusLabels[selectedAsset.status]?.label ?? selectedAsset.status}</span>
                  <span>Length</span>
                  <span>{lengthOf(selectedAsset)}</span>
                  <span>Picture</span>
                  <span>{selectedAsset.width && selectedAsset.height ? `${selectedAsset.width} × ${selectedAsset.height}` : "—"}</span>
                  <span>Uploaded</span>
                  <span>{new Date(selectedAsset.createdAt).toLocaleString()}</span>
                </div>
              </div>

              <div className="card stack-sm asset-modal-card">
                <span className="eyebrow">Used in</span>
                <strong>Loops using this file</strong>
                {selectedAsset.slotUsages.length === 0 ? (
                  <div className="empty-state compact">
                    <strong>Not used in a loop</strong>
                    <p>Choose it in the loop builder.</p>
                  </div>
                ) : (
                  <div className="usage-list">
                    {selectedAsset.slotUsages.map((placement) => (
                      <span
                        key={`${placement.usageType}-${placement.slot.loop.id}-${placement.slot.position}-${selectedAsset.id}`}
                      >
                        {placement.slot.loop.name} · slot {placement.slot.position + 1} ·{" "}
                        {placement.usageType === "STATIC" ? "still image" : "plays in the slot"}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
