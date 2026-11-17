"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  directLoopUploadMaxBytes,
  directLoopUploadMaxDurationMs,
} from "@orison/shared/src/constants";

import { ConfirmDialog, type ConfirmRequest } from "@/components/loop-ui";
import { useToast } from "@/components/toast-provider";

function formatFileSize(bytes: number) {
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1000)} KB`;
  }

  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function DirectLoopUploadForm({ deviceGroups }: { deviceGroups: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const [name, setName] = useState("");
  // Where it plays once ready; by default it is kept off air until someone puts it on.
  const [target, setTarget] = useState("library");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      progress: Math.max(current.progress, 76),
    }));

    progressTimerRef.current = window.setInterval(() => {
      setUploadState((current) => ({
        ...current,
        progress: Math.min(current.progress + 2, 96),
      }));
    }, 300);
  }

  function resetForm() {
    setName("");
    setSelectedFile(null);
    setError(null);
    setUploadState({
      phase: "idle",
      progress: 0,
    });
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function validateFile(file: File | null) {
    if (!file) {
      return "Choose a video file to upload.";
    }

    if (!/\.(mp4|mov|m4v)$/i.test(file.name)) {
      return "Pre-built loops must be an MP4 or MOV file.";
    }

    if (file.size > directLoopUploadMaxBytes) {
      return `Pre-built loops are limited to ${Math.round(
        directLoopUploadMaxBytes / (1024 * 1024),
      )}MB.`;
    }

    return null;
  }

  function handleFileSelect(file: File | null) {
    setSelectedFile(file);
    setError(validateFile(file));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (name.trim().length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }

    const fileError = validateFile(selectedFile);
    if (fileError || !selectedFile) {
      setError(fileError ?? "Choose a video file to upload.");
      return;
    }
    if (target === "library") {
      void upload(selectedFile);
      return;
    }
    const where = target === "all" ? "all cabs" : `group ${deviceGroups.find((group) => group.id === target)?.name ?? "?"}`;
    setConfirm({
      title: `Put it on air for ${where}?`,
      message: `As soon as it has been converted, "${name.trim()}" replaces what ${where} play${target === "all" ? "" : "s"} now. Choose "Keep it off air" to check it first.`,
      confirmLabel: "Upload and put on air",
      onConfirm: () => upload(selectedFile),
    });
  }

  async function upload(selectedFile: File) {

    setError(null);
    setUploadState({
      phase: "uploading",
      progress: 6,
    });

    const result = await new Promise<{
      ok: boolean;
      body: { error?: string; loopId?: string };
    }>(
      (resolve) => {
        const request = new XMLHttpRequest();
        const params = new URLSearchParams({
          name: name.trim(),
          filename: selectedFile.name,
          target,
        });

        const parseResponseBody = () => {
          if (!request.responseText) {
            return {};
          }

          try {
            return JSON.parse(request.responseText) as { error?: string; loopId?: string };
          } catch {
            const responseText = request.responseText.trim();
            return {
              error:
                request.status >= 500
                  ? "The server could not finish converting this video. Try again; if it fails again, the details are in the server log."
                  : responseText || `Upload failed (HTTP ${request.status}).`,
            };
          }
        };

        request.open("POST", `/api/loops/direct-upload?${params.toString()}`);
        request.setRequestHeader("Content-Type", selectedFile.type || "video/mp4");

        request.upload.onprogress = (progressEvent) => {
          if (!progressEvent.lengthComputable) {
            return;
          }

          const next = 10 + Math.round((progressEvent.loaded / progressEvent.total) * 64);
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
            body: {
              error: "The upload was interrupted. Check the connection and try again.",
            },
          });
        };

        request.onabort = () => {
          stopProgressTimer();
          resolve({
            ok: false,
            body: {
              error: "The upload was cancelled.",
            },
          });
        };

        request.onload = () => {
          stopProgressTimer();
          const body = parseResponseBody();

          resolve({
            ok: request.status >= 200 && request.status < 300,
            body,
          });
        };

        request.send(selectedFile);
      },
    );

    if (!result.ok || !result.body.loopId) {
      setUploadState({
        phase: "idle",
        progress: 0,
      });
      setError(result.body.error ?? "The upload failed.");
      toast({
        title: "Upload failed",
        message: result.body.error ?? "The pre-built loop could not be saved.",
        tone: "error",
      });
      return;
    }

    setUploadState({
      phase: "processing",
      progress: 100,
    });
    toast({
      title: target === "library" ? "Loop saved" : "Loop on air",
      message: target === "library" ? "It is off air until you put it on." : "It was converted and is on air.",
      tone: "success",
    });
    resetForm();
    router.push(`/loops/${result.body.loopId}`);
    router.refresh();
  }

  return (
    <form className="asset-upload-stack" onSubmit={handleSubmit}>
      <label className="field">
        <span>Name</span>
        <input
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. DAZN finished edit, 10 min"
          required
          value={name}
        />
      </label>

      <label
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
          handleFileSelect(event.dataTransfer.files[0] ?? null);
        }}
      >
        <input
          accept=".mp4,.mov,.m4v,video/mp4,video/quicktime"
          hidden
          onChange={(event) => handleFileSelect(event.target.files?.[0] ?? null)}
          ref={inputRef}
          type="file"
        />
        <span className="drop-zone-kicker">Video file</span>
        <strong>Drop the finished video here, or click to choose it</strong>
        <span className="muted">
          {selectedFile
            ? `${selectedFile.name} · ${formatFileSize(selectedFile.size)}`
            : `Maximum ${Math.round(directLoopUploadMaxBytes / (1024 * 1024))}MB · up to ${
                directLoopUploadMaxDurationMs / 60000
              } minutes`}
        </span>
      </label>

      {uploadState.phase !== "idle" ? (
        <div className="upload-progress-card">
          <div className="card-header">
            <strong>
              {uploadState.phase === "uploading" ? "Uploading" : "Converting to the cab format"}
            </strong>
            <span>{uploadState.progress}%</span>
          </div>
          <div className="progress-track">
            <span className="progress-fill" style={{ width: `${uploadState.progress}%` }} />
          </div>
          <span className="muted">
            {uploadState.phase === "uploading"
              ? "Keep this page open until the upload finishes."
              : "The video is being checked and converted. This can take a few minutes for a long video."}
          </span>
        </div>
      ) : null}

      <label className="field">
        <span>When it is ready</span>
        <select onChange={(event) => setTarget(event.target.value)} value={target}>
          <option value="library">Keep it off air (put it on later)</option>
          <option value="all">Put it on air for all cabs</option>
          {deviceGroups.map((group) => (
            <option key={group.id} value={group.id}>
              Put it on air for group {group.name}
            </option>
          ))}
        </select>
      </label>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="button-row">
        <button
          className="button button-primary"
          disabled={!selectedFile || uploadState.phase !== "idle" || !name.trim()}
          type="submit"
        >
          {uploadState.phase === "idle" ? (target === "library" ? "Upload" : "Upload and put on air") : "Working…"}
        </button>
      </div>
      {confirm ? <ConfirmDialog onClose={() => setConfirm(null)} request={confirm} /> : null}
    </form>
  );
}
