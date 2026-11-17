"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { AlertIcon, CheckIcon, UploadIcon, VideosIcon } from "../components/icons";
import { href, Notice, Screen, Section, Sheet, Spinner, TopBar } from "../components/ui";
import { duration, fileSize, preparingWords, quoted } from "../lib/format";
import { cabCount, decodeTarget, encodeTarget, impactOf, isSwitchedOn, lagPhrase, targetName } from "../lib/status";
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

/**
 * "wifi", "cellular" or "unknown". Safari (every iPhone) has no navigator.connection, so most of
 * the time we simply don't know, and must not assume mobile data.
 */
export function connectionKind(nav: { connection?: { type?: string } } | undefined): "wifi" | "cellular" | "unknown" {
  const type = nav?.connection?.type;
  if (type === "wifi" || type === "ethernet") return "wifi";
  if (type === "cellular") return "cellular";
  return "unknown";
}

export function UploadScreen({ initialTarget }: { initialTarget: string | null }) {
  const { job } = useUpload();
  // Once the bytes have arrived, preparing carries on at the server: another video can be uploaded.
  const canUploadAnother = !job || job.phase === "processing";
  return (
    <Screen>
      <TopBar title="Upload a video" large={!job} />
      {job ? <JobView job={job} /> : null}
      {job && canUploadAnother ? <h2 className="m-upload-another" data-testid="upload-another-head">Upload another video</h2> : null}
      {canUploadAnother ? <UploadForm initialTarget={job ? null : initialTarget} /> : null}
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
  const network = typeof navigator === "undefined" ? "unknown" : connectionKind(navigator as Navigator & { connection?: { type?: string } });
  const wifi = network === "wifi";
  const cellular = network === "cellular";

  function begin() {
    if (!file) return;
    setConfirmOpen(false);
    start({ file, name: name.trim(), target, targetLabel: target && overview.data ? targetName(overview.data, target) : null, seconds });
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
    // Only ask about mobile data when the phone says it is on mobile data.
    if (target || (large && cellular)) {
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
            sub={overview.data ? onceReady(impactOf(overview.data, { type: "fleet" }, null).cabs.length, overview.data.cabs.length === 0 ? "There are no cabs yet" : "No cab follows all cabs right now") : "Once it’s ready"}
          />
          {(overview.data?.groups ?? []).map((group) => (
            <Radio
              key={group.id}
              value={`group:${group.id}`}
              current={destination}
              onChange={setDestination}
              title={`${group.name} group`}
              sub={onceReady(impactOf(overview.data!, { type: "group", groupId: group.id }, null).cabs.length, "No cabs in this group yet")}
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

      {large && !wifi && !cellular && file && !fileError ? (
        <Notice tone="info" title="A large video" testId="upload-large-note">
          It&rsquo;s {fileSize(file.size)}. If you&rsquo;re on mobile data rather than Wi-Fi, it uses that much of your allowance and can take a while. Keep
          Orison open with the screen on while it uploads; if the connection drops it carries on from where it stopped.
        </Notice>
      ) : null}
      {large && cellular && file && !fileError ? (
        <Notice tone="info" title="Wi-Fi recommended" testId="upload-wifi-note">
          This video is {fileSize(file.size)}. On mobile data, uploading it uses about {fileSize(file.size)} of your allowance and can take
          a long time, because phones send much more slowly than they download. Keep Orison open with the screen on while it uploads; if the
          connection drops or the phone locks, it carries on from where it stopped when you&rsquo;re back.
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
              {target && impact ? (impact.cabs.length > 0 ? `Yes, upload for ${cabCount(impact.cabs.length)}` : "Yes, upload it") : "Upload anyway"}
            </button>
          </>
        }
      >
        {target && impact && overview.data && impact.cabs.length === 0 ? (
          <p className="m-body-text" data-testid="upload-confirm-empty">
            As soon as it&rsquo;s ready, {quoted(name.trim())} becomes the video for{" "}
            <b>{target.type === "fleet" ? "all cabs" : targetName(overview.data, target)}</b>.{" "}
            {target.type === "group"
              ? "There are no cabs in this group yet, so no screen changes now; cabs added to it later play it."
              : target.type === "fleet" && overview.data.cabs.length === 0
                ? "There are no cabs yet; new cabs play it when they’re first switched on."
                : "No cab follows it right now, so no screen changes now."}{" "}
            If someone changes what plays there while this is uploading, their change is kept and this video just goes into Videos.
          </p>
        ) : target && impact && overview.data ? (
          <p className="m-body-text">
            As soon as it&rsquo;s ready, {quoted(name.trim())} will play on{" "}
            <b>{target.type === "fleet" ? "all cabs" : targetName(overview.data, target)}</b>, changing {cabCount(impact.cabs.length)}. Cabs that are on switch{" "}
            {lagPhrase(impact.cabs.filter(isSwitchedOn), overview.data.changeLagMinutes)} of it being ready; cabs that are off switch the next time
            they&rsquo;re switched on. If someone changes what plays there while this is uploading, their change is kept and this video just goes into
            Videos.
          </p>
        ) : null}
        {large && cellular && file ? (
          <Notice tone="info" title="Large video">
            It&rsquo;s {fileSize(file.size)}. If you&rsquo;re not on Wi-Fi this uses {fileSize(file.size)} of mobile data and can take a long time. Keep the
            app open with the screen on while it uploads; if the connection drops it carries on from where it stopped.
          </Notice>
        ) : null}
      </Sheet>
    </form>
  );
}

function onceReady(count: number, emptyWords: string) {
  return count === 0 ? `${emptyWords}; nothing changes on screens` : `Changes ${cabCount(count)} once it’s ready`;
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
  const { cancel, dismiss, resumeWith } = useUpload();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 30_000 });
  const percent = job.size ? Math.min(100, Math.floor((job.loaded / job.size) * 100)) : 0;
  const remaining = job.rate && job.rate > 0 ? (job.size - job.loaded) / job.rate : null;
  const waiting = job.loop?.processing.waiting ?? false;
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

      {job.phase === "uploading" && job.needsFile ? (
        <div className="m-card m-job-card" data-testid="upload-needs-file">
          <div className="m-job-row">
            <strong>Stopped at {percent}%</strong>
          </div>
          <div className="m-progress" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="m-body-text">
            The app was closed before {quoted(job.name)} had finished uploading. Choose the same video again ({job.fileName}, {fileSize(job.size)})
            and it carries on from where it stopped.
          </p>
          <label className="m-btn m-btn-primary m-btn-block" htmlFor="m-resume-file">
            Choose {job.fileName} again
          </label>
          <input
            id="m-resume-file"
            type="file"
            accept="video/mp4,video/quicktime,video/x-m4v,video/*,.mp4,.mov,.m4v"
            className="m-visually-hidden"
            data-testid="upload-resume-file"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (!picked) return;
              setResumeError(null);
              void resumeWith(picked).then((ok) => {
                if (!ok) setResumeError(`That isn’t the same video. Choose ${job.fileName} (${fileSize(job.size)}), or start a new upload.`);
              });
            }}
          />
          {resumeError ? (
            <Notice tone="warn" testId="upload-resume-error">
              {resumeError}
            </Notice>
          ) : null}
          <button type="button" className="m-btn m-btn-ghost m-btn-block" onClick={cancel} data-testid="upload-cancel">
            Forget it and start a new upload
          </button>
        </div>
      ) : null}

      {job.phase === "uploading" && !job.needsFile ? (
        <div className="m-card m-job-card" data-testid="upload-sending">
          <div className="m-job-row">
            <strong>{job.finishing ? "Checking the video" : job.waitingForConnection ? "Waiting for a connection" : "Uploading"}</strong>
            <strong data-testid="upload-percent">{percent}%</strong>
          </div>
          <div className="m-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Upload progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="m-muted" data-testid="upload-progress-text">
            {job.loaded > 0 ? `${fileSize(job.loaded)} of ${fileSize(job.size)} received` : `Nothing received yet of ${fileSize(job.size)}`}
            {remaining !== null && percent < 100 && !job.waitingForConnection ? ` · about ${remaining < 60 ? "a few seconds" : duration(remaining)} left` : ""}
          </p>
          {job.waitingForConnection ? (
            <Notice tone="warn" title="Connection lost" testId="upload-waiting">
              Nothing sent so far is lost. It carries on from {percent}% by itself as soon as the connection is back.
            </Notice>
          ) : null}
          {job.restarted ? (
            <Notice tone="info" title="Started again" testId="upload-restarted">
              Our server restarted and lost what had been sent, so the upload started again from the beginning. Nothing for you to do.
            </Notice>
          ) : null}
          <Notice tone="info">
            Keep Orison open with the screen on until this reaches 100%. If the connection drops it carries on from where it stopped; if the app is
            closed, choose the same video again and it carries on too. After 100% you can close it; we&rsquo;ll finish getting the video ready.
          </Notice>
          <button type="button" className="m-btn m-btn-ghost m-btn-block" onClick={cancel} data-testid="upload-cancel">
            Cancel upload
          </button>
        </div>
      ) : null}

      {job.phase === "processing" ? (
        <div className="m-card m-job-card" data-testid="upload-processing">
          <div className="m-job-row">
            <strong>{waiting ? "Waiting its turn" : "Getting it ready for the screens"}</strong>
            <Spinner />
          </div>
          <div className="m-progress m-progress-indeterminate" aria-hidden="true">
            <span />
          </div>
          <p className="m-body-text" data-testid="upload-processing-text">
            {waiting
              ? "Uploaded. Another video is being prepared first (one at a time); this one starts as soon as that’s done."
              : `Uploaded. We’re now preparing it for the cab screens. ${preparingWords(job.seconds ? job.seconds * 1000 : job.loop?.durationMs)}`}
          </p>
          <p className="m-muted">
            You can leave this screen, close the app or upload another video below. It carries on, and shows in Videos while it&rsquo;s being prepared.
          </p>
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
          ) : job.target && impact && impact.cabs.length === 0 ? (
            <p className="m-body-text" data-testid="upload-ready-empty">
              {quoted(job.name)} is now the video for {job.target.type === "fleet" ? "all cabs" : job.targetLabel}.{" "}
              {job.target.type === "group" ? "There are no cabs in this group yet; cabs added to it later play it." : "No screen changes right now."}
            </p>
          ) : job.target ? (
            <p className="m-body-text">
              {quoted(job.name)} is going out to {impact ? cabCount(impact.cabs.length) : job.targetLabel}. Cabs that are on switch{" "}
              {lagPhrase((impact?.cabs ?? []).filter(isSwitchedOn), overview.data?.changeLagMinutes ?? 30)}; cabs that are off switch the next time
              they&rsquo;re switched on.
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
