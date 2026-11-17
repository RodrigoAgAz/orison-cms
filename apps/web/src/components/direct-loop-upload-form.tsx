"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  directLoopUploadMaxBytes,
  directLoopUploadMaxDurationMs,
} from "@orison/shared/src/constants";

import { ConfirmDialog, type ConfirmRequest } from "@/components/loop-ui";
import { useToast } from "@/components/toast-provider";
import { fileFingerprint, sendFileInPieces, UploadCancelled, UploadRefused } from "@/lib/piece-sender";

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
  const abortRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [name, setName] = useState("");
  // Where it plays once ready; by default it is kept off air until someone puts it on.
  const [target, setTarget] = useState("library");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<{
    phase: "idle" | "uploading" | "finishing";
    progress: number;
  }>({
    phase: "idle",
    progress: 0,
  });

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
      // Not awaited: the dialog closes at once and the progress card below shows the upload.
      onConfirm: () => {
        void upload(selectedFile);
      },
    });
  }

  async function upload(file: File) {
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
        open: { kind: "loop", name: name.trim(), target },
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
      const loopId = typeof result.loopId === "string" ? result.loopId : null;
      toast({
        title: "Uploaded",
        message:
          target === "library"
            ? "It is being converted, then kept off air until you put it on."
            : "It is being converted and goes on air as soon as it is ready.",
        tone: "success",
      });
      resetForm();
      if (loopId) router.push(`/loops/${loopId}`);
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

  function cancelUpload() {
    abortRef.current?.abort();
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
            <strong>{uploadState.phase === "uploading" ? (waiting ? "Waiting for the connection" : "Uploading") : "Handing over for conversion"}</strong>
            <span>{uploadState.progress}%</span>
          </div>
          <div className="progress-track">
            <span className="progress-fill" style={{ width: `${uploadState.progress}%` }} />
          </div>
          <span className="muted">
            {uploadState.phase === "uploading"
              ? waiting
                ? "The connection dropped. The upload carries on by itself when it is back."
                : "Keep this page open until the upload finishes. If it is closed, choose the same file again to carry on."
              : "The whole file has arrived. It is converted to the cab format in the background."}
          </span>
          {uploadState.phase === "uploading" ? (
            <div className="button-row">
              <button className="button button-secondary" onClick={cancelUpload} type="button">
                Cancel upload
              </button>
            </div>
          ) : null}
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
