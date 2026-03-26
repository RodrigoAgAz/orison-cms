"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { MediaPoster } from "@/components/media-poster";
import { Modal } from "@/components/modal";
import { PaginationControls } from "@/components/pagination-controls";
import { StatusPill } from "@/components/status-pill";
import { useToast } from "@/components/toast-provider";

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

  return advertiser ?? campaign ?? "No campaign metadata";
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
  const progressTimerRef = useRef<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>(currentCategory || "ALL");
  const [query, setQuery] = useState(currentQuery);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [category, setCategory] = useState("ADVERTISEMENT");
  const [advertiserName, setAdvertiserName] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<AssetItem | null>(null);
  const [uploadState, setUploadState] = useState<{
    phase: "idle" | "uploading" | "processing";
    progress: number;
  }>({
    phase: "idle",
    progress: 0,
  });

  function stopProgressTimer() {
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }

  function startProcessingProgress() {
    stopProgressTimer();
    setUploadState((current) => ({
      phase: "processing",
      progress: Math.max(current.progress, 72),
    }));

    progressTimerRef.current = window.setInterval(() => {
      setUploadState((current) => ({
        ...current,
        progress: Math.min(current.progress + 3, 94),
      }));
    }, 250);
  }

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

    setError(null);
    setUploadState({
      phase: "uploading",
      progress: 8,
    });

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("category", category);
    formData.append(
      "metadata",
      JSON.stringify({
        advertiserName: advertiserName.trim() || undefined,
        campaignName: campaignName.trim() || undefined,
      }),
    );

    const result = await new Promise<{
      ok: boolean;
      body: { error?: string; filename?: string };
    }>((resolve) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/assets/upload");

      request.upload.onprogress = (progressEvent) => {
        if (!progressEvent.lengthComputable) {
          return;
        }

        const next = 12 + Math.round((progressEvent.loaded / progressEvent.total) * 58);
        setUploadState({
          phase: "uploading",
          progress: next,
        });
      };

      request.upload.onload = () => {
        startProcessingProgress();
      };

      request.onerror = () => {
        stopProgressTimer();
        resolve({
          ok: false,
          body: { error: "Upload failed. Check the dev server and try again." },
        });
      };

      request.onload = () => {
        stopProgressTimer();
        let body: { error?: string; filename?: string } = {};

        if (request.responseText) {
          try {
            body = JSON.parse(request.responseText) as { error?: string; filename?: string };
          } catch {
            body = {
              error:
                request.status >= 500
                  ? `The server returned an invalid ${request.status} response while processing the asset.`
                  : `Upload failed with HTTP ${request.status}.`,
            };
          }
        }

        resolve({
          ok: request.status >= 200 && request.status < 300,
          body,
        });
      };

      request.send(formData);
    });

    if (!result.ok) {
      setError(result.body.error ?? "Upload failed");
      setUploadState({
        phase: "idle",
        progress: 0,
      });
      toast({
        title: "Upload failed",
        message: result.body.error ?? "The asset could not be processed.",
        tone: "error",
      });
      return;
    }

    setUploadState({
      phase: "processing",
      progress: 100,
    });
    toast({
      title: "Asset processed",
      message: `${result.body.filename} is ready in the library.`,
      tone: "success",
    });
    resetForm();
    router.refresh();
  }

  async function handleDelete(assetId: string) {
    const confirmed = window.confirm("Delete this asset?");
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/assets/${assetId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      const message = body?.error ?? "Delete failed";
      toast({
        title: "Delete failed",
        message,
        tone: "error",
      });
      return;
    }

    toast({
      title: "Asset deleted",
      message: "The asset has been removed from the library.",
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
            <span className="eyebrow">Asset Upload</span>
            <h2>Content Library</h2>
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
              accept=".mp4,.mov,.webm,.jpg,.jpeg,.png"
              hidden
              name="file"
              onChange={(event) => handleFileSelect(event.target.files?.item(0) ?? null)}
              ref={inputRef}
              type="file"
            />
            <span className="drop-zone-kicker">Drag files here or click to browse</span>
            <strong>{selectedFile?.name ?? "MP4, MOV, WEBM, JPG, JPEG, PNG"}</strong>
            <span className="muted">
              {selectedFile
                ? `${formatFileSize(selectedFile.size)} ready to upload`
                : "Transcoding runs automatically after upload and generates a thumbnail."}
            </span>
          </button>

          <div className="asset-upload-grid">
            <label className="field">
              <span>Category</span>
              <select onChange={(event) => setCategory(event.target.value)} value={category}>
                {categories
                  .filter((item) => item !== "ALL")
                  .map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
              </select>
            </label>

            <label className="field">
              <span>Advertiser Name</span>
              <input
                onChange={(event) => setAdvertiserName(event.target.value)}
                placeholder="Nike, Pret, TfL..."
                value={advertiserName}
              />
            </label>

            <label className="field">
              <span>Campaign Name</span>
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
                  {uploadState.phase === "uploading" ? "Uploading asset" : "Transcoding and indexing"}
                </strong>
                <span>{uploadState.progress}%</span>
              </div>
              <div className="progress-track">
                <span className="progress-fill" style={{ width: `${uploadState.progress}%` }} />
              </div>
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
                "Upload Asset"
              ) : (
                <span className="button-inline">
                  <span aria-hidden className="button-spinner" />
                  Processing asset
                </span>
              )}
            </button>
          </div>
        </form>
      </div>

      <form className="toolbar" onSubmit={applyFilters}>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by filename, advertiser, or campaign"
          value={query}
        />
        <select onChange={(event) => setSelectedCategory(event.target.value)} value={selectedCategory}>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <div className="button-row">
          <button className="button button-secondary" type="submit">
            Apply Filters
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
              ? "No assets match the current filters"
              : "No assets uploaded yet"}
          </strong>
          <p>
            {currentQuery || currentCategory !== "ALL"
              ? "Try broadening the search or resetting the category filter."
              : "Upload your first advertisement, static creative, or filler file to start building loops."}
          </p>
          <div className="button-row">
            {currentQuery || currentCategory !== "ALL" ? (
              <button className="button button-secondary" onClick={clearFilters} type="button">
                Clear Filters
              </button>
            ) : (
              <button
                className="button button-primary"
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                Upload First Asset
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
                label={asset.mimeType.startsWith("video/") ? "Video preview" : "Image asset"}
                src={asset.thumbnailUrl}
              />

              <div className="stack-sm">
                <div className="card-header">
                  <strong>{asset.filename}</strong>
                  <StatusPill value={asset.status} />
                </div>

                <span className="muted">{assetSummary(asset)}</span>

                <div className="meta-grid">
                  <span>Category</span>
                  <span>{asset.category}</span>
                  <span>Duration</span>
                  <span>{asset.durationMs ? `${Math.round(asset.durationMs / 1000)}s` : "n/a"}</span>
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
          eyebrow="Asset Preview"
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
                  Open asset
                </a>
                <button
                  className="button button-danger"
                  onClick={() => void handleDelete(selectedAsset.id)}
                  type="button"
                >
                  Delete asset
                </button>
              </div>
            </div>

            <div className="stack">
              <div className="card stack-sm asset-modal-card">
                <span className="eyebrow">Metadata</span>
                <div className="meta-grid">
                  <span>Advertiser</span>
                  <span>{selectedAsset.metadata.advertiserName ?? "n/a"}</span>
                  <span>Campaign</span>
                  <span>{selectedAsset.metadata.campaignName ?? "n/a"}</span>
                  <span>Status</span>
                  <span>{selectedAsset.status}</span>
                  <span>Category</span>
                  <span>{selectedAsset.category}</span>
                  <span>Uploaded</span>
                  <span>{new Date(selectedAsset.createdAt).toLocaleString()}</span>
                </div>
              </div>

              <div className="card stack-sm asset-modal-card">
                <span className="eyebrow">Usage</span>
                <strong>Loops and slots using this asset</strong>
                {selectedAsset.slotUsages.length === 0 ? (
                  <div className="empty-state compact">
                    <strong>Not used in a loop yet</strong>
                    <p>This asset is available to assign from the loop builder.</p>
                  </div>
                ) : (
                  <div className="usage-list">
                    {selectedAsset.slotUsages.map((placement) => (
                      <span
                        key={`${placement.usageType}-${placement.slot.loop.id}-${placement.slot.position}-${selectedAsset.id}`}
                      >
                        {placement.slot.loop.name} / Slot {placement.slot.position + 1} /{" "}
                        {placement.usageType === "STATIC" ? "Static creative" : "Video segment"} /{" "}
                        {placement.slot.loop.status}
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
