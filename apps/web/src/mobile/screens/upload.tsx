"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { AlertIcon, CheckIcon, UploadIcon, VideosIcon } from "../components/icons";
import { href, Notice, Screen, Section, Sheet, Spinner, TopBar } from "../components/ui";
import { duration, fileSize, plural, quoted } from "../lib/format";
import { cabCount, decodeTarget, encodeTarget, impactOf, targetName } from "../lib/status";
import { useResource } from "../lib/store";
import type { AssignTarget, Overview } from "../lib/types";
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SECONDS,
  readVideoDuration,
  useUpload,
  type UploadJob,
} from "../lib/upload";

const LARGE_BYTES = 50 * 1024 * 1024;

function extensionOf(name: string) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function suggestedName(fileName: string) {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  return /^(IMG|MOV|VID|trim)\b/i.test(base) ? "" : base.slice(0, 120);
}

function onWifi() {
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return connection?.type === "wifi" || connection?.type === "ethernet";
}

export function UploadScreen({ initialTarget }: { initialTarget: string | null }) {
  const { job } = useUpload();
  return (
    <Screen>
      <TopBar title="Upload a video" large={!job} />
      {job ? <JobView job={job} /> : <UploadForm initialTarget={initialTarget} />}
    </Screen>
  );
}

function UploadForm({ initialTarget }: { initialTarget: string | null }) {
  const { start } = useUpload();
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 60_000 });
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<string>(decodeTarget(initialTarget) ? initialTarget! : "library");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    setFileError(null);
    setFormError(null);
    setSeconds(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(picked);
    if (!picked) return;
    if (!name) setName(suggestedName(picked.name));
    if (!ACCEPTED_EXTENSIONS.includes(extensionOf(picked.name))) {
      setFileError("This file type can’t be used. Choose an MP4 or MOV video. Videos from the iPhone camera are fine.");
      return;
    }
    if (picked.size === 0) {
      setFileError("This file is empty. Choose another video.");
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setFileError(`This video is ${fileSize(picked.size)}. The limit is 500 MB. Trim it in Photos, or export it at a lower quality, then try again.`);
      return;
    }
    setPreview(URL.createObjectURL(picked));
    setChecking(true);
    const length = await readVideoDuration(picked);
    setChecking(false);
    setSeconds(length);
    if (length !== null && length > MAX_UPLOAD_SECONDS) {
      setFileError(`This video is ${duration(length)} long. Videos can be up to 14 minutes. Trim it in Photos first.`);
    }
  }

  const target: AssignTarget | null = destination === "library" ? null : decodeTarget(destination);
  const impact = useMemo(
    () => (overview.data && target ? impactOf(overview.data, target, { id: "new", name: name || "this video", posterUrl: null }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview.data, destination, name],
  );
  const large = Boolean(file && file.size > LARGE_BYTES);
  const wifi = typeof navigator !== "undefined" && onWifi();

  function begin() {
    if (!file) return;
    setConfirmOpen(false);
    start({ file, name: name.trim(), target, targetLabel: target && overview.data ? targetName(overview.data, target) : null });
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setFormError("Choose a video first.");
      return;
    }
    if (fileError) return;
    if (name.trim().length < 2) {
      setFormError("Give the video a name (at least 2 letters) so your team can recognise it.");
      return;
    }
    setFormError(null);
    if (target || (large && !wifi)) {
      setConfirmOpen(true);
      return;
    }
    begin();
  }

  return (
    <form className="m-form m-upload" onSubmit={onSubmit} noValidate>
      <Section title="1. Choose the video">
        <label className={`m-filepick ${file ? "has-file" : ""}`} htmlFor="m-file">
          {preview && !fileError ? (
            <video className="m-filepick-preview" src={preview} muted playsInline preload="metadata" />
          ) : (
            <span className="m-filepick-icon">
              <VideosIcon size={30} />
            </span>
          )}
          <span className="m-filepick-text">
            {file ? (
              <>
                <strong>{file.name}</strong>
                <span className="m-muted">
                  {fileSize(file.size)}
                  {checking ? " · checking…" : seconds ? ` · ${seconds < 60 ? `${Math.round(seconds)} sec` : duration(seconds)}` : ""}
                </span>
                <span className="m-filepick-change">Choose a different video</span>
              </>
            ) : (
              <>
                <strong>Choose from Photos or Files</strong>
                <span className="m-muted">MP4 or MOV, up to 500 MB and 14 minutes</span>
              </>
            )}
          </span>
        </label>
        <input
          ref={inputRef}
          id="m-file"
          type="file"
          accept="video/mp4,video/quicktime,video/x-m4v,video/*,.mp4,.mov,.m4v"
          className="m-visually-hidden"
          onChange={(event) => void onPick(event)}
          data-testid="upload-file"
        />
        {fileError ? (
          <Notice tone="danger" testId="upload-file-error">
            {fileError}
          </Notice>
        ) : null}
      </Section>

      <Section title="2. Name it">
        <label className="m-field">
          <span>Video name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example: Spring sale, March"
            maxLength={120}
            autoComplete="off"
            enterKeyHint="done"
            data-testid="upload-name"
          />
          <small>This is how it shows up in the app. Passengers don&rsquo;t see it.</small>
        </label>
      </Section>

      <Section title="3. Where should it play?">
        <div className="m-radios" role="radiogroup" aria-label="Where should it play?">
          <Radio value="library" current={destination} onChange={setDestination} title="Just add it to Videos" sub="Nothing changes on the screens yet" />
          <Radio
            value="fleet"
            current={destination}
            onChange={setDestination}
            title="All cabs"
            sub={overview.data ? `Changes ${cabCount(impactOf(overview.data, { type: "fleet" }, null).cabs.length)} once it’s ready` : "Once it’s ready"}
          />
          {(overview.data?.groups ?? []).map((group) => (
            <Radio
              key={group.id}
              value={`group:${group.id}`}
              current={destination}
              onChange={setDestination}
              title={`${group.name} group`}
              sub={`Changes ${cabCount(impactOf(overview.data!, { type: "group", groupId: group.id }, null).cabs.length)} once it’s ready`}
            />
          ))}
          <label className={`m-radio ${destination.startsWith("cab:") ? "is-checked" : ""}`}>
            <span className="m-radio-dot" aria-hidden="true" />
            <span className="m-radio-text">
              <strong>One cab</strong>
              <select
                value={destination.startsWith("cab:") ? destination : ""}
                onChange={(event) => setDestination(event.target.value || "library")}
                aria-label="Choose a cab"
                data-testid="upload-cab-select"
              >
                <option value="">Choose a cab…</option>
                {(overview.data?.cabs ?? []).map((cab) => (
                  <option key={cab.id} value={encodeTarget({ type: "cab", deviceId: cab.id })}>
                    {cab.label}
                    {cab.driverName ? ` (${cab.driverName})` : ""}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
      </Section>

      {large && !wifi && file && !fileError ? (
        <Notice tone="info" title="Wi-Fi recommended">
          This video is {fileSize(file.size)}. On mobile data, uploading it uses about {fileSize(file.size)} of your allowance.
        </Notice>
      ) : null}
      {formError ? (
        <Notice tone="danger" testId="upload-form-error">
          {formError}
        </Notice>
      ) : null}

      <div className="m-stickyactions">
        <button type="submit" className="m-btn m-btn-primary m-btn-block m-btn-big" disabled={Boolean(fileError) || checking} data-testid="upload-submit">
          <UploadIcon size={20} /> {target ? "Upload and put on screens" : "Upload"}
        </button>
      </div>

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={target ? "Upload and put on screens?" : "Upload on mobile data?"}
        testId="upload-confirm"
        footer={
          <>
            <button type="button" className="m-btn m-btn-ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button type="button" className="m-btn m-btn-primary" onClick={begin} data-testid="upload-confirm-go">
              {target && impact ? `Yes, upload for ${cabCount(impact.cabs.length)}` : "Upload anyway"}
            </button>
          </>
        }
      >
        {target && impact && overview.data ? (
          <p className="m-body-text">
            As soon as it&rsquo;s ready, {quoted(name.trim())} will play on{" "}
            <b>{target.type === "fleet" ? "all cabs" : targetName(overview.data, target)}</b>, changing {cabCount(impact.cabs.length)}. Cabs that are on switch
            within about {plural(overview.data.changeLagMinutes, "minute")} of it being ready; cabs that are off switch the next time they&rsquo;re switched on.
          </p>
        ) : null}
        {large && !wifi && file ? (
          <Notice tone="info" title="Large video">
            It&rsquo;s {fileSize(file.size)}. If you&rsquo;re not on Wi-Fi this uses {fileSize(file.size)} of mobile data. Keep the app open until the upload
            reaches 100%.
          </Notice>
        ) : null}
      </Sheet>
    </form>
  );
}

function Radio({
  value,
  current,
  onChange,
  title,
  sub,
}: {
  value: string;
  current: string;
  onChange: (value: string) => void;
  title: string;
  sub: string;
}) {
  const checked = current === value;
  return (
    <label className={`m-radio ${checked ? "is-checked" : ""}`}>
      <input type="radio" name="destination" value={value} checked={checked} onChange={() => onChange(value)} className="m-visually-hidden" />
      <span className="m-radio-dot" aria-hidden="true" />
      <span className="m-radio-text">
        <strong>{title}</strong>
        <span className="m-muted">{sub}</span>
      </span>
    </label>
  );
}

function JobView({ job }: { job: UploadJob }) {
  const { cancel, dismiss } = useUpload();
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 30_000 });
  const percent = job.size ? Math.min(100, Math.floor((job.loaded / job.size) * 100)) : 0;
  const remaining = job.rate && job.rate > 0 ? (job.size - job.loaded) / job.rate : null;
  const steps: Array<{ key: string; label: string }> = [
    { key: "uploading", label: "Upload" },
    { key: "processing", label: "Get it ready" },
    { key: "ready", label: job.target ? "On screens" : "In Videos" },
  ];
  const order = { uploading: 0, processing: 1, ready: 2, failed: -1 } as const;
  const current = order[job.phase];
  const failedAt = job.phase === "failed" ? (job.loopId ? 1 : 0) : -1;
  const impact = job.target && overview.data && job.loop ? impactOf(overview.data, job.target, { id: job.loop.id, name: job.loop.name, posterUrl: job.loop.posterUrl }) : null;

  return (
    <div className="m-job" data-testid="upload-job" data-phase={job.phase}>
      <div className="m-job-head">
        <span className="m-label">{job.fileName}</span>
        <h2>{quoted(job.name)}</h2>
        {job.targetLabel ? <p className="m-muted">Going to: {job.target?.type === "fleet" ? "All cabs" : job.targetLabel}</p> : <p className="m-muted">Going to: Videos</p>}
      </div>

      <ol className="m-steps" aria-label="Progress">
        {steps.map((step, index) => {
          const state = failedAt === index ? "failed" : current > index || job.phase === "ready" ? "done" : current === index ? "active" : "todo";
          return (
            <li key={step.key} className={`m-stepper is-${state}`}>
              <span className="m-stepper-dot" aria-hidden="true">
                {state === "done" ? <CheckIcon size={14} /> : state === "failed" ? <AlertIcon size={14} /> : index + 1}
              </span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>

      {job.phase === "uploading" ? (
        <div className="m-card m-job-card">
          <div className="m-job-row">
            <strong>Uploading</strong>
            <strong data-testid="upload-percent">{percent}%</strong>
          </div>
          <div className="m-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Upload progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="m-muted">
            {fileSize(job.loaded)} of {fileSize(job.size)}
            {remaining !== null && percent < 100 ? ` · about ${remaining < 60 ? "a few seconds" : duration(remaining)} left` : ""}
          </p>
          <Notice tone="info">Keep Orison open until this reaches 100%. After that you can close it; we&rsquo;ll finish getting the video ready.</Notice>
          <button type="button" className="m-btn m-btn-ghost m-btn-block" onClick={cancel} data-testid="upload-cancel">
            Cancel upload
          </button>
        </div>
      ) : null}

      {job.phase === "processing" ? (
        <div className="m-card m-job-card" data-testid="upload-processing">
          <div className="m-job-row">
            <strong>Getting it ready for the screens</strong>
            <Spinner />
          </div>
          <div className="m-progress m-progress-indeterminate" aria-hidden="true">
            <span />
          </div>
          <p className="m-body-text">Uploaded. We&rsquo;re now preparing it for the cab screens, which usually takes a minute or two.</p>
          <p className="m-muted">You can leave this screen or close the app. It carries on, and shows in Videos while it&rsquo;s being prepared.</p>
        </div>
      ) : null}

      {job.phase === "ready" ? (
        <div className="m-card m-job-card m-job-ready" data-testid="upload-ready">
          <div className="m-done-head">
            <span className="m-done-check" aria-hidden="true">
              <CheckIcon size={28} />
            </span>
            <h2>{job.target && !job.warning ? "Ready and on its way" : "Ready"}</h2>
          </div>
          {job.warning ? (
            <Notice tone="warn" title="It’s in Videos, but not on screens">
              {job.warning}
            </Notice>
          ) : job.target ? (
            <p className="m-body-text">
              {quoted(job.name)} is going out to {impact ? cabCount(impact.cabs.length) : job.targetLabel}. Cabs that are on switch within about{" "}
              {plural(overview.data?.changeLagMinutes ?? 5, "minute")}; cabs that are off switch the next time they&rsquo;re switched on.
            </p>
          ) : (
            <p className="m-body-text">{quoted(job.name)} is in Videos. Nothing on the screens has changed.</p>
          )}
          <div className="m-actions">
            {job.loopId && !job.target ? (
              <Link href={href(`/m/change?loop=${job.loopId}`)} className="m-btn m-btn-primary m-btn-block" data-testid="upload-put-on">
                Put it on screens
              </Link>
            ) : null}
            {job.loopId ? (
              <Link href={href(`/m/videos/${job.loopId}`)} className={`m-btn ${job.target ? "m-btn-primary" : "m-btn-secondary"} m-btn-block`} onClick={dismiss} data-testid="upload-see">
                See the video
              </Link>
            ) : null}
            <button type="button" className="m-btn m-btn-ghost m-btn-block" onClick={dismiss}>
              Upload another
            </button>
          </div>
        </div>
      ) : null}

      {job.phase === "failed" ? (
        <div className="m-card m-job-card" data-testid="upload-failed">
          <Notice tone="danger" title={job.loopId ? "This video couldn’t be prepared" : "The upload didn’t work"} testId="upload-failed-reason">
            {job.error}
          </Notice>
          {job.loopId ? <p className="m-muted">It&rsquo;s listed in Videos so you can see what happened and remove it.</p> : null}
          <button type="button" className="m-btn m-btn-primary m-btn-block" onClick={dismiss} data-testid="upload-retry">
            Choose a video again
          </button>
        </div>
      ) : null}
    </div>
  );
}
