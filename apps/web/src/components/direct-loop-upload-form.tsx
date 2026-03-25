"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { directLoopUploadMaxBytes, loopDurationMs } from "@orison/shared";

import { useToast } from "@/components/toast-provider";

function formatFileSize(bytes: number) {
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1000)} KB`;
  }

  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function DirectLoopUploadForm() {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const [name, setName] = useState("");
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
      return "Choose an MP4 file to upload.";
    }

    if (!file.name.toLowerCase().endsWith(".mp4")) {
      return "Direct loop uploads must be provided as an .mp4 file.";
    }

    if (file.size > directLoopUploadMaxBytes) {
      return `Direct loop uploads are limited to ${Math.round(
        directLoopUploadMaxBytes / (1024 * 1024),
      )}MB.`;
    }

    return null;
  }

  function handleFileSelect(file: File | null) {
    setSelectedFile(file);
    setError(validateFile(file));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim()) {
      setError("Enter a loop name before uploading.");
      return;
    }

    const fileError = validateFile(selectedFile);
    if (fileError || !selectedFile) {
      setError(fileError ?? "Choose an MP4 file to upload.");
      return;
    }

    setError(null);
    setUploadState({
      phase: "uploading",
      progress: 6,
    });

    const result = await new Promise<{ ok: boolean; body: { error?: string; loopId?: string } }>(
      (resolve) => {
        const request = new XMLHttpRequest();
        const params = new URLSearchParams({
          name: name.trim(),
          filename: selectedFile.name,
        });

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
              error: "Upload failed. Check the deployment logs and try again.",
            },
          });
        };

        request.onload = () => {
          stopProgressTimer();
          const body = request.responseText
            ? (JSON.parse(request.responseText) as { error?: string; loopId?: string })
            : {};

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
      setError(result.body.error ?? "Direct loop upload failed.");
      toast({
        title: "Upload failed",
        message: result.body.error ?? "The pre-built loop could not be published.",
        tone: "error",
      });
      return;
    }

    setUploadState({
      phase: "processing",
      progress: 100,
    });
    toast({
      title: "Loop published",
      message: "The pre-built loop was transcoded, uploaded, and published successfully.",
      tone: "success",
    });
    resetForm();
    router.push(`/loops/${result.body.loopId}`);
    router.refresh();
  }

  return (
    <form className="asset-upload-stack" onSubmit={handleSubmit}>
      <label className="field">
        <span>Loop Name</span>
        <input
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder="Week 12 - Direct Master"
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
          accept=".mp4,video/mp4"
          hidden
          onChange={(event) => handleFileSelect(event.target.files?.[0] ?? null)}
          ref={inputRef}
          type="file"
        />
        <span className="drop-zone-kicker">Upload Pre-built Loop</span>
        <strong>Drop a finished ten-minute MP4 here or click to browse</strong>
        <span className="muted">
          {selectedFile
            ? `${selectedFile.name} · ${formatFileSize(selectedFile.size)}`
            : `Maximum ${Math.round(directLoopUploadMaxBytes / (1024 * 1024))}MB · up to ${
                loopDurationMs / 60000
              } minutes`}
        </span>
      </label>

      {uploadState.phase !== "idle" ? (
        <div className="upload-progress-card">
          <div className="card-header">
            <strong>
              {uploadState.phase === "uploading" ? "Uploading master loop" : "Transcoding and publishing"}
            </strong>
            <span>{uploadState.progress}%</span>
          </div>
          <div className="progress-track">
            <span className="progress-fill" style={{ width: `${uploadState.progress}%` }} />
          </div>
          <span className="muted">
            {uploadState.phase === "uploading"
              ? "The MP4 is being streamed to the CMS."
              : "The uploaded file is being normalized, stored, and published to devices."}
          </span>
        </div>
      ) : null}

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="button-row">
        <button
          className="button button-primary"
          disabled={!selectedFile || uploadState.phase !== "idle" || !name.trim()}
          type="submit"
        >
          {uploadState.phase === "idle" ? "Upload and Publish" : "Processing..."}
        </button>
      </div>
    </form>
  );
}
