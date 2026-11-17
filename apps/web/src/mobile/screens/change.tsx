"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { CabsIcon, CheckIcon, ChevronIcon, LayersIcon, MapIcon, UploadIcon } from "../components/icons";
import {
  ErrorState,
  href,
  LoadingScreen,
  Notice,
  Poster,
  Screen,
  Spinner,
  StatusBadge,
  StatusShape,
  TopBar,
} from "../components/ui";
import { api, ApiFailure } from "../lib/api";
import { quoted, videoLength } from "../lib/format";
import {
  cabCount,
  changeIsInPlace,
  changesWords,
  decodeTarget,
  encodeTarget,
  impactOf,
  isSwitchedOn,
  lagPhrase,
  placeWords,
  targetName,
  type Impact,
} from "../lib/status";
import { fetchResource, invalidate, useResource } from "../lib/store";
import type { AssignTarget, CabSummary, LoopRef, LoopSummary, Overview } from "../lib/types";

type Choice = string | "inherit" | null;
type Result = {
  target: AssignTarget;
  loop: LoopRef | null;
  cabIds: string[];
  affected: number;
  inherit: boolean;
  /** Cabs that already showed the video before the change (their screens don't change). */
  alreadyIds: string[];
  /** We never got the server's answer; the change was confirmed by reading the cabs back. */
  confirmedAfterSilence?: boolean;
};

function targetPhrase(overview: Overview, target: AssignTarget) {
  if (target.type === "fleet") return "all cabs";
  if (target.type === "group") {
    const name = overview.groups.find((group) => group.id === target.groupId)?.name;
    return name ? `the ${name} group` : "this group";
  }
  return targetName(overview, target);
}

export function ChangeScreen({ initialLoop, initialTarget }: { initialLoop: string | null; initialTarget: string | null }) {
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 15_000 });
  const loops = useResource<{ items: LoopSummary[] }>("/api/m/loops", { refreshMs: 60_000 });
  const [choice, setChoice] = useState<Choice>(initialLoop);
  const [target, setTarget] = useState<AssignTarget | null>(decodeTarget(initialTarget));
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The change got no answer: it may or may not have been applied. */
  const [unsure, setUnsure] = useState<{ checking: boolean; message: string } | null>(null);
  const [cabPicker, setCabPicker] = useState(false);

  const data = overview.data;
  const ready = useMemo(
    () => (loops.data?.items ?? []).filter((loop) => loop.status === "PUBLISHED" && loop.processing.state === "ready"),
    [loops.data],
  );

  const top = <TopBar title="Change what plays" back={{ fallback: "/m", label: result ? "Cabs" : "Cancel" }} />;

  if (!data || !loops.data) {
    const failure = overview.error ?? loops.error;
    return (
      <Screen>
        {top}
        {failure ? <ErrorState message={failure.message} onRetry={() => void Promise.all([overview.refresh(), loops.refresh()])} /> : <LoadingScreen />}
      </Screen>
    );
  }

  // Inheriting only makes sense for a group (follow all cabs) or a cab (follow its group).
  const group = target?.type === "group" ? data.groups.find((item) => item.id === target.groupId) ?? null : null;
  const cab = target?.type === "cab" ? data.cabs.find((item) => item.id === target.deviceId) ?? null : null;
  const canInherit = Boolean((group && !group.followsFleet) || (cab && cab.expectedSource === "cab"));
  const effectiveChoice: Choice = choice === "inherit" && (!target || target.type === "fleet") ? null : choice;
  const chosenLoop: LoopSummary | null = effectiveChoice && effectiveChoice !== "inherit" ? ready.find((loop) => loop.id === effectiveChoice) ?? null : null;
  const loopMissing = Boolean(effectiveChoice && effectiveChoice !== "inherit" && !chosenLoop);

  if (result) {
    return (
      <Screen>
        {top}
        <Done result={result} overview={data} />
      </Screen>
    );
  }

  // ---- Step 1: video ----
  if (!effectiveChoice || loopMissing) {
    const cabGroup = cab?.group ? data.groups.find((item) => item.id === cab.group?.id) : null;
    const inheritLoop = group ? data.fleetLoop : cab ? cabGroup?.loop ?? data.fleetLoop : null;
    const currentId = group ? group.loop?.id : cab ? cab.expected?.id : target?.type === "fleet" ? data.fleetLoop?.id : null;
    return (
      <Screen>
        {top}
        <div className="m-flowhead">
          <span className="m-step">Step 1 of {target ? 2 : 3}</span>
          <h2>Choose a video</h2>
          {target ? <p className="m-muted">For {targetPhrase(data, target)}</p> : null}
        </div>
        {loopMissing ? <Notice tone="warn">That video isn&rsquo;t available any more. Choose another one.</Notice> : null}

        {canInherit && inheritLoop !== undefined ? (
          <button type="button" className="m-option m-option-special" onClick={() => setChoice("inherit")} data-testid="choose-inherit">
            <span className="m-option-icon">
              <LayersIcon size={22} />
            </span>
            <span className="m-option-text">
              <strong>{group ? "Same as all cabs" : `Go back to ${cab?.group ? `${cab.group.name}’s video` : "the video for all cabs"}`}</strong>
              <span className="m-muted">
                {inheritLoop ? `Plays ${quoted(inheritLoop.name)} and follows future changes` : "Follows future changes"}
              </span>
            </span>
            <ChevronIcon size={18} className="m-listrow-chev" />
          </button>
        ) : null}

        {ready.length === 0 ? (
          <Notice tone="info">There are no videos ready yet. Upload one first.</Notice>
        ) : (
          <ul className="m-optionlist" data-testid="choose-video-list">
            {ready.map((loop) => (
              <li key={loop.id}>
                <button
                  type="button"
                  className="m-option"
                  onClick={() => setChoice(loop.id)}
                  data-testid="choose-video"
                  data-loop-id={loop.id}
                  data-loop-name={loop.name}
                >
                  <Poster src={loop.posterUrl} alt="" ratio="thumb" className="m-option-thumb" />
                  <span className="m-option-text">
                    <strong>{loop.name}</strong>
                    <span className="m-muted">
                      {[videoLength(loop.durationMs), loop.id === currentId ? (target?.type === "group" && group?.cabCount === 0 ? "chosen there now" : "playing there now") : placeWords(loop.liveOn)?.text ?? "not playing anywhere"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <ChevronIcon size={18} className="m-listrow-chev" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Link href={href(`/m/upload${target ? `?target=${encodeTarget(target)}` : ""}`)} className="m-btn m-btn-ghost m-btn-block">
          <UploadIcon size={18} /> Upload a new video instead
        </Link>
      </Screen>
    );
  }

  // ---- Step 2: where ----
  if (!target) {
    const loopRef: LoopRef | null = chosenLoop ? { id: chosenLoop.id, name: chosenLoop.name, posterUrl: chosenLoop.posterUrl } : null;
    const fleetImpact = impactOf(data, { type: "fleet" }, loopRef);
    return (
      <Screen>
        {top}
        <div className="m-flowhead">
          <span className="m-step">Step 2 of 3</span>
          <h2>Where should it play?</h2>
          <ChosenVideo loop={chosenLoop} onChange={() => setChoice(null)} />
        </div>
        <ul className="m-optionlist" data-testid="choose-target-list">
          <li>
            <button type="button" className="m-option" onClick={() => setTarget({ type: "fleet" })} data-testid="target-fleet">
              <span className="m-option-icon">
                <LayersIcon size={22} />
              </span>
              <span className="m-option-text">
                <strong>All cabs</strong>
                <span className="m-muted">
                  {changesWords(fleetImpact, "No cabs yet")}
                  {fleetImpact.keepOwn.groups.length || fleetImpact.keepOwn.cabs.length ? " · some keep their own video" : ""}
                </span>
              </span>
              <ChevronIcon size={18} className="m-listrow-chev" />
            </button>
          </li>
          {data.groups.map((item) => {
            const impact = impactOf(data, { type: "group", groupId: item.id }, loopRef);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="m-option"
                  onClick={() => setTarget({ type: "group", groupId: item.id })}
                  data-testid="target-group"
                  data-group-id={item.id}
                >
                  <span className="m-option-icon">
                    <MapIcon size={22} />
                  </span>
                  <span className="m-option-text">
                    <strong>{item.name} group</strong>
                    <span className="m-muted">{changesWords(impact, "No cabs in this group yet")}</span>
                  </span>
                  <ChevronIcon size={18} className="m-listrow-chev" />
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className={`m-option ${cabPicker ? "is-open" : ""}`}
              onClick={() => setCabPicker((value) => !value)}
              aria-expanded={cabPicker}
              data-testid="target-one-cab"
            >
              <span className="m-option-icon">
                <CabsIcon size={22} />
              </span>
              <span className="m-option-text">
                <strong>Just one cab</strong>
                <span className="m-muted">Gives that cab its own video</span>
              </span>
              <ChevronIcon size={18} className="m-listrow-chev m-rot" />
            </button>
          </li>
        </ul>
        {cabPicker ? (
          <ul className="m-list m-card m-cabpick" data-testid="cab-picker">
            {data.cabs.map((item) => (
              <li key={item.id}>
                <button type="button" className="m-listrow" onClick={() => setTarget({ type: "cab", deviceId: item.id })} data-cab-id={item.id}>
                  <span className="m-listrow-text">
                    <strong>{item.label}</strong>
                    <span className="m-muted">{[item.group?.name, item.driverName].filter(Boolean).join(" · ") || "No group"}</span>
                  </span>
                  <StatusBadge cab={item} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Screen>
    );
  }

  // ---- Step 3: confirm ----
  const inherit = effectiveChoice === "inherit";
  const loopRef: LoopRef | null = chosenLoop ? { id: chosenLoop.id, name: chosenLoop.name, posterUrl: chosenLoop.posterUrl } : null;
  const impact = impactOf(data, target, inherit ? null : loopRef);
  const resultName = impact.resultLoop ? quoted(impact.resultLoop.name) : "the video";

  let question: string;
  let explain: string | null = null;
  if (inherit && target.type === "group") {
    question = `Make ${targetName(data, target)} play the same as all cabs?`;
    explain = `They will play ${resultName} and follow any future change for all cabs.`;
  } else if (inherit && target.type === "cab") {
    const groupName = cab?.group?.name;
    question = groupName ? `Put ${cab?.label} back on ${groupName}’s video?` : `Put ${cab?.label} back on the video for all cabs?`;
    explain = `It will play ${resultName}${groupName ? `, like the rest of ${groupName},` : ""} and follow future changes.`;
  } else if (target.type === "cab") {
    question = `Play ${resultName} in ${cab?.label ?? "this cab"}?`;
    explain = `This cab gets its own video. It stays on it until you change it or send it back to ${cab?.group ? `${cab.group.name}’s` : "the all-cabs"} video.`;
  } else if (target.type === "group") {
    question =
      group?.cabCount === 0
        ? `Choose ${resultName} for the ${group.name} group?`
        : `Play ${resultName} on ${targetName(data, target)}?`;
  } else {
    question = `Play ${resultName} on all cabs?`;
  }

  const sentLoopId = inherit ? null : effectiveChoice;
  const alreadyIds = impact.alreadyPlaying.map((item) => item.id);

  /** Read the cabs back after a change that got no answer, and say what actually happened. */
  async function checkUnsure() {
    if (!target) return;
    setUnsure((current) => (current ? { ...current, checking: true } : current));
    try {
      await fetchResource("/api/m/overview", { force: true });
      const fresh = await api<Overview>("/api/m/overview");
      if (changeIsInPlace(fresh, target, sentLoopId)) {
        const decided = impactOf(fresh, target, inherit ? null : impact.resultLoop);
        setUnsure(null);
        setResult({
          target,
          loop: impact.resultLoop,
          cabIds: decided.cabs.map((item) => item.id),
          affected: decided.cabs.length,
          inherit,
          alreadyIds,
          confirmedAfterSilence: true,
        });
        void invalidate("/api/m/");
        window.scrollTo({ top: 0 });
        return;
      }
      setUnsure(null);
      setError("It didn’t go through: the cabs are still set as before. Nothing changed, so you can try again.");
    } catch {
      setUnsure({
        checking: false,
        message:
          "We still can’t reach the server to check. The change may have gone through. When you have a signal, tap “Check again”, or look at what the cabs are set to play on the Cabs screen before trying again.",
      });
    }
  }

  async function confirm() {
    if (!target) return;
    setBusy(true);
    setError(null);
    setUnsure(null);
    try {
      const response = await api<{ ok: true; affectedCabs: number; affectedCabIds?: string[] }>("/api/m/assign", {
        method: "POST",
        json: { loopId: sentLoopId, target },
      });
      // The server's answer, not the phone's prediction: someone may have changed things meanwhile.
      setResult({
        target,
        loop: impact.resultLoop,
        cabIds: response.affectedCabIds ?? [],
        affected: response.affectedCabs,
        inherit,
        alreadyIds,
      });
      void invalidate("/api/m/");
      window.scrollTo({ top: 0 });
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.uncertain) {
        setUnsure({ checking: true, message: failure.message });
        setBusy(false);
        await checkUnsure();
        return;
      }
      setError(failure instanceof Error ? failure.message : "That didn’t work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const n = impact.changing.length;
  const placeName = target.type === "fleet" ? "all cabs" : target.type === "group" ? `${group?.name ?? "the group"}` : cab?.label ?? "this cab";
  const confirmLabel =
    n === 0
      ? target.type === "cab"
        ? "Yes, make the change"
        : `Yes, set it for ${placeName}`
      : inherit
        ? `Yes, switch ${cabCount(n)}`
        : `Yes, play it on ${cabCount(n)}`;

  return (
    <Screen>
      {top}
      <div className="m-flowhead">
        <span className="m-step">Check and confirm</span>
      </div>
      <div className="m-card m-confirm" data-testid="confirm-card">
        <div className="m-confirm-media">
          <Poster src={impact.resultLoop?.posterUrl} alt="" ratio="wide" />
        </div>
        <h2 className="m-confirm-q" data-testid="confirm-question">
          {question}
        </h2>
        {explain ? <p className="m-body-text">{explain}</p> : null}

        <ImpactFacts impact={impact} target={target} overview={data} />

        <div className="m-confirm-edit">
          {!(target.type === "fleet" && initialTarget === "fleet") ? (
            <button type="button" className="m-link" onClick={() => setTarget(null)}>
              Change where
            </button>
          ) : null}
          <button type="button" className="m-link" onClick={() => setChoice(null)}>
            Choose a different video
          </button>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {unsure ? (
        <Notice tone="warn" title="Not sure it went through" testId="change-unsure">
          {unsure.checking ? "We didn’t hear back from the server. Checking whether the change was made…" : unsure.message}
        </Notice>
      ) : null}
      <div className="m-stickyactions">
        {unsure && !unsure.checking ? (
          <button type="button" className="m-btn m-btn-primary m-btn-block m-btn-big" onClick={() => void checkUnsure()} data-testid="change-check-again">
            Check again
          </button>
        ) : (
          <button
            type="button"
            className="m-btn m-btn-primary m-btn-block m-btn-big"
            onClick={() => void confirm()}
            disabled={busy || Boolean(unsure)}
            data-testid="confirm-change"
          >
            {busy || unsure ? <Spinner /> : null}
            {unsure ? "Checking…" : busy ? "Sending to the cabs…" : confirmLabel}
          </button>
        )}
      </div>
    </Screen>
  );
}

function ChosenVideo({ loop, onChange }: { loop: LoopSummary | null; onChange: () => void }) {
  if (!loop) return null;
  return (
    <div className="m-chosen">
      <Poster src={loop.posterUrl} alt="" ratio="thumb" />
      <span className="m-chosen-text">
        <span className="m-label">Video</span>
        <strong>{loop.name}</strong>
      </span>
      <button type="button" className="m-link" onClick={onChange}>
        Change
      </button>
    </div>
  );
}

function ImpactFacts({ impact, target, overview }: { impact: Impact; target: AssignTarget; overview: Overview }) {
  const changing = impact.changing;
  const n = changing.length;
  const onCabs = changing.filter(isSwitchedOn);
  const on = onCabs.length;
  const lag = lagPhrase(onCabs, overview.changeLagMinutes);
  const off = changing.filter((item) => item.status === "offline").length;
  const paused = changing.filter((item) => item.status === "paused").length;
  return (
    <div className="m-facts" data-testid="impact">
      <p className="m-facts-head" data-testid="impact-count">
        {impact.cabs.length === 0
          ? target.type === "group"
            ? "There are no cabs in this group yet, so no screen changes."
            : target.type === "fleet"
              ? overview.cabs.length === 0
                ? "There are no cabs yet, so no screen changes."
                : "No cab follows the video for all cabs right now, so no screen changes."
              : "No screen changes."
          : n === 0
            ? impact.alreadyPlaying.length === impact.cabs.length
              ? impact.cabs.length === 1
                ? "No change: it’s already playing this video."
                : "No change: they’re all already playing this video."
              : "No change: already set to play this video."
            : `This changes ${cabCount(n)}.`}
      </p>
      <ul>
        {on > 0 ? (
          <li>
            <StatusShape tone="on" /> <span>
              <b>{on} switched on</b>: {on === 1 ? "it changes" : "they change"} {lag}.
            </span>
          </li>
        ) : null}
        {off > 0 ? (
          <li>
            <StatusShape tone="off" /> <span>
              <b>{off} off</b>: {off === 1 ? "it changes" : "they change"} the next time {off === 1 ? "it’s" : "they’re"} switched on.
            </span>
          </li>
        ) : null}
        {paused > 0 ? (
          <li>
            <StatusShape tone="paused" /> <span>
              <b>{paused} paused</b>: {paused === 1 ? "it changes" : "they change"} when the screen is resumed.
            </span>
          </li>
        ) : null}
        {n > 0 && impact.alreadyHeading.length > 0 ? (
          <li>
            <CheckIcon size={14} /> <span>
              <b>{impact.alreadyHeading.length} already set to play it</b>, so no change there.
            </span>
          </li>
        ) : null}
        {n > 0 && impact.alreadyPlaying.length > 0 ? (
          <li>
            <CheckIcon size={14} /> <span>
              <b>{impact.alreadyPlaying.length} already playing it</b>, so no change there.
            </span>
          </li>
        ) : null}
      </ul>
      {impact.keepOwn.groups.length > 0 || impact.keepOwn.cabs.length > 0 ? (
        <p className="m-facts-keep" data-testid="impact-keep">
          <b>Not changing: </b>
          {[
            ...impact.keepOwn.groups.map((item) => `${item.name} (${cabCount(item.count)}) has its own video`),
            ...impact.keepOwn.cabs.map((item) => `${item.label} has its own video`),
          ].join("; ")}
          .
        </p>
      ) : null}
      {impact.cabs.length === 0 && target.type === "fleet" ? (
        <p className="m-facts-keep">
          {overview.cabs.length === 0
            ? "It becomes the video every new cab plays when it’s first switched on."
            : "Every cab is following its group’s or its own video. This becomes the video for any cab that follows all cabs later."}
        </p>
      ) : null}
      {impact.cabs.length === 0 && target.type === "group" ? (
        <p className="m-facts-keep">Cabs added to this group later play it.</p>
      ) : null}
      {overview.fleetPaused ? <p className="m-facts-keep">All screens are paused at the moment, so nothing plays until they&rsquo;re resumed.</p> : null}
    </div>
  );
}

function Done({ result, overview }: { result: Result; overview: Overview }) {
  // The overview keeps refreshing (every 15s) so cabs tick over as they pick the change up.
  const cabs = result.cabIds
    .map((id) => overview.cabs.find((item) => item.id === id))
    .filter((item): item is CabSummary => Boolean(item));
  const resultId = result.loop?.id;
  const changed = cabs.filter((item) => resultId && item.playing?.id === resultId);
  const name = result.loop ? quoted(result.loop.name) : "The new video";
  const switching = cabs.filter((item) => !result.alreadyIds.includes(item.id)).length;
  const already = cabs.length - switching;
  const pendingOnCabs = cabs.filter((item) => isSwitchedOn(item) && !changed.includes(item));
  const pendingOn = pendingOnCabs.length;
  const lag = lagPhrase(pendingOnCabs, overview.changeLagMinutes);
  const pendingOff = cabs.filter((item) => item.status === "offline" && !changed.includes(item)).length;

  return (
    <div className="m-done" data-testid="change-done">
      <div className="m-done-head">
        <span className="m-done-check" aria-hidden="true">
          <CheckIcon size={30} />
        </span>
        <h2>Done</h2>
        <p data-testid="done-summary">
          {result.affected === 0
            ? `${name} is now set for ${targetPhrase(overview, result.target)}. ${
                result.target.type === "group"
                  ? "There are no cabs in this group yet; cabs added to it later play it."
                  : result.target.type === "fleet" && overview.cabs.length === 0
                    ? "There are no cabs yet; new cabs play it."
                    : "No screen needed to change."
              }`
            : switching === 0
              ? `${name} is now set for ${targetPhrase(overview, result.target)}. ${
                  already === 1 ? "The cab was already playing it" : "Every cab there was already playing it"
                }, so no screen changes.`
              : `${name} is going out to ${cabCount(switching)}${already > 0 ? ` (${already} already had it)` : ""}.`}
        </p>
        {result.confirmedAfterSilence ? (
          <p className="m-muted" data-testid="done-confirmed">
            The server didn&rsquo;t answer at first, so we checked: the change is in place.
          </p>
        ) : null}
      </div>

      {cabs.length > 0 ? (
        <>
          <div className="m-card m-done-what">
            <h3 className="m-subhead">What happens next</h3>
            <ul className="m-facts-plain">
              {pendingOn > 0 ? <li>Cabs that are on switch {lag}. This page updates as they do.</li> : null}
              {pendingOff > 0 ? <li>Cabs that are off switch the next time they&rsquo;re switched on.</li> : null}
              {pendingOn === 0 && pendingOff === 0 ? <li>Every cab has it already.</li> : null}
            </ul>
            <p className="m-done-progress" data-testid="done-progress">
              <b>{changed.length}</b> of {cabCount(result.affected)} playing it so far
            </p>
          </div>
          <ul className="m-list m-card" data-testid="done-cabs">
            {cabs.map((item) => {
              const has = Boolean(resultId && item.playing?.id === resultId);
              return (
                <li key={item.id}>
                  <Link href={href(`/m/cabs/${item.id}`)} className="m-listrow" data-cab-id={item.id}>
                    <span className="m-listrow-text">
                      <strong>{item.label}</strong>
                      <span className={`m-muted ${has ? "m-ok" : ""}`}>
                        {has
                          ? "Playing it now"
                          : isSwitchedOn(item)
                            ? `Switching, ${lagPhrase([item], overview.changeLagMinutes)}`
                            : item.status === "paused"
                              ? "Will switch when its screen is resumed"
                              : "Will switch when it’s next on"}
                      </span>
                    </span>
                    {has ? (
                      <span className="m-status m-status-on m-status-md">
                        <CheckIcon size={13} /> <span>Done</span>
                      </span>
                    ) : (
                      <StatusBadge cab={item} />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <div className="m-actions">
        <Link href={href("/m")} className="m-btn m-btn-primary m-btn-block" data-testid="done-home">
          Back to cabs
        </Link>
      </div>
    </div>
  );
}
