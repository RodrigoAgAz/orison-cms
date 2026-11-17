import { ago, plural, quoted, when } from "./format";
import type { AssignTarget, CabSummary, LoopRef, Overview } from "./types";

export type Tone = "on" | "switching" | "off" | "paused";

export function cabTone(cab: Pick<CabSummary, "status">): Tone {
  switch (cab.status) {
    case "online":
      return "on";
    case "updating":
      return "switching";
    case "paused":
      return "paused";
    default:
      return "off";
  }
}

export const toneWord: Record<Tone, string> = {
  on: "On",
  switching: "On · switching",
  off: "Off",
  paused: "Paused",
};

export function isSwitchedOn(cab: Pick<CabSummary, "status">) {
  return cab.status === "online" || cab.status === "updating";
}

/**
 * What the screen is doing right now, in words, or null. Passenger wording ("Waiting for a
 * passenger") only for a cab known to play for passenger journeys (`reportsJourneys`): a box with
 * no passenger input never has one, and between journeys every screen shows a still.
 */
export function passengerLine(cab: Pick<CabSummary, "playerStatus" | "status" | "reportsJourneys" | "playingBuiltIn">) {
  if (!isSwitchedOn(cab)) return null;
  if (cab.playingBuiltIn && cab.playerStatus !== "disabled" && cab.playerStatus !== "error") return "Showing its built-in video";
  switch (cab.playerStatus) {
    case "fallback":
      return "Showing its built-in video";
    case "error":
      return "Its video player isn’t responding";
    case "disabled":
      return "Screen turned off in the cab";
    default:
      break;
  }
  if (cab.reportsJourneys) {
    switch (cab.playerStatus) {
      case "journey":
        return "Passenger on board";
      case "silent":
        return "Passenger turned the sound off";
      case "idle":
        return "Waiting for a passenger (showing a still)";
      default:
        return null;
    }
  }
  switch (cab.playerStatus) {
    case "journey":
      return "Playing the video";
    case "idle":
      return "Showing a still from the video";
    default:
      return null;
  }
}

/** One short line describing how long the cab has been on, or when it was last seen. */
export function onLine(cab: CabSummary, now = new Date()) {
  if (isSwitchedOn(cab)) {
    if (cab.onlineSince) {
      return `On since ${when(cab.onlineSince, now)}`;
    }
    return "On now";
  }
  if (!cab.lastSeenAt) return "Never switched on yet";
  return `Last on ${when(cab.lastSeenAt, now)}`;
}

/** What the cab is (or will be) showing, in words. */
export function contentLine(cab: CabSummary) {
  if (cab.isUpToDate || !cab.expected) {
    return cab.playing ? quoted(cab.playing.name) : cab.playingBuiltIn ? "Its built-in video" : "Nothing yet";
  }
  if (cab.status === "updating") {
    return cab.playingBuiltIn ? `Built-in video, fetching ${quoted(cab.expected.name)}` : `Switching to ${quoted(cab.expected.name)}`;
  }
  if (cab.status === "paused") return `${quoted(cab.expected.name)} when resumed`;
  return `${quoted(cab.expected.name)} when it next starts`;
}

/**
 * How long cabs take to act on a change, in words: "within about 5 minutes". Each cab's figure
 * depends on its software (older screens only check every 30 minutes). For a mix, both bounds:
 * "within about 5 minutes, or up to 30 minutes for cabs on older software".
 */
export function lagPhrase(cabs: Array<Pick<CabSummary, "changeLagMinutes">>, fallbackMinutes: number) {
  const values = cabs.map((cab) => cab.changeLagMinutes).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return `within about ${plural(fallbackMinutes, "minute")}`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return `within about ${plural(max, "minute")}`;
  return `within about ${plural(min, "minute")}, or up to ${plural(max, "minute")} for cabs on older software`;
}

export function sourceLine(cab: CabSummary) {
  switch (cab.expectedSource) {
    case "cab":
      return "Its own video, chosen for this cab";
    case "group":
      return `Chosen for the ${cab.group?.name ?? "group"} group`;
    case "fleet":
      return "Same as all cabs";
    default:
      return "Nothing chosen yet";
  }
}

export function lastSeenWords(cab: CabSummary) {
  if (!cab.lastSeenAt) return "never";
  return ago(cab.lastSeenAt);
}

// ---------------------------------------------------------------------------------------------
// Who a change affects. Mirrors the server's routing rule: a cab's own video beats its group,
// a group's own choice beats "all cabs".

export type Impact = {
  cabs: CabSummary[];
  on: CabSummary[];
  off: CabSummary[];
  paused: CabSummary[];
  /** Already showing the video: their screen does not change. */
  alreadyPlaying: CabSummary[];
  /** Not showing it yet but already set to switch to it: this change does nothing to them. */
  alreadyHeading: CabSummary[];
  /** The cabs this change actually changes (neither of the two above). */
  changing: CabSummary[];
  /** For "all cabs": places that keep their own choice and will not change. */
  keepOwn: { groups: { id: string; name: string; count: number }[]; cabs: CabSummary[] };
  /** The video the cabs end up with (resolved for "go back" choices). */
  resultLoop: LoopRef | null;
};

export function followsFleet(cab: CabSummary, overview: Overview) {
  if (cab.expectedSource === "fleet") return true;
  if (cab.expectedSource !== null) return false;
  if (!cab.group) return true;
  return overview.groups.find((group) => group.id === cab.group?.id)?.followsFleet ?? true;
}

export function impactOf(overview: Overview, target: AssignTarget, loop: LoopRef | null): Impact {
  let cabs: CabSummary[] = [];
  const keepOwn: Impact["keepOwn"] = { groups: [], cabs: [] };
  if (target.type === "fleet") {
    cabs = overview.cabs.filter((cab) => followsFleet(cab, overview));
    for (const group of overview.groups) {
      if (group.followsFleet) continue;
      const count = overview.cabs.filter((cab) => cab.group?.id === group.id && cab.expectedSource !== "cab").length;
      if (count > 0) keepOwn.groups.push({ id: group.id, name: group.name, count });
    }
    keepOwn.cabs = overview.cabs.filter((cab) => cab.expectedSource === "cab");
  } else if (target.type === "group") {
    cabs = overview.cabs.filter((cab) => cab.group?.id === target.groupId && cab.expectedSource !== "cab");
    keepOwn.cabs = overview.cabs.filter((cab) => cab.group?.id === target.groupId && cab.expectedSource === "cab");
  } else {
    cabs = overview.cabs.filter((cab) => cab.id === target.deviceId);
  }

  let resultLoop: LoopRef | null = null;
  if (loop) {
    resultLoop = loop;
  } else if (target.type === "group") {
    resultLoop = overview.fleetLoop;
  } else if (target.type === "cab") {
    const cab = cabs[0];
    const group = cab?.group ? overview.groups.find((item) => item.id === cab.group?.id) : null;
    resultLoop = group?.loop ?? overview.fleetLoop;
  }

  const resultId = resultLoop?.id ?? null;
  const alreadyPlaying = resultId ? cabs.filter((cab) => cab.playing?.id === resultId) : [];
  const alreadyHeading = resultId ? cabs.filter((cab) => cab.playing?.id !== resultId && cab.expected?.id === resultId) : [];
  const changing = cabs.filter((cab) => !alreadyPlaying.includes(cab) && !alreadyHeading.includes(cab));
  return {
    cabs,
    on: cabs.filter(isSwitchedOn),
    off: cabs.filter((cab) => cab.status === "offline"),
    paused: cabs.filter((cab) => cab.status === "paused"),
    alreadyPlaying,
    alreadyHeading,
    changing,
    keepOwn,
    resultLoop,
  };
}

export function targetName(overview: Overview | undefined, target: AssignTarget) {
  if (target.type === "fleet") return "All cabs";
  if (target.type === "group") {
    const name = overview?.groups.find((group) => group.id === target.groupId)?.name ?? "this group";
    return `${name} cabs`;
  }
  return overview?.cabs.find((cab) => cab.id === target.deviceId)?.label ?? "this cab";
}

export function cabCount(count: number) {
  return plural(count, "cab");
}

/**
 * Subtitle for a place in the "where should it play?" step: how many cabs the change really
 * changes, and plain words when that is none.
 */
export function changesWords(impact: Impact, emptyWords: string) {
  if (impact.cabs.length === 0) return emptyWords;
  const n = impact.changing.length;
  if (n > 0) return `Changes ${cabCount(n)}`;
  if (impact.alreadyPlaying.length === impact.cabs.length) {
    return impact.cabs.length === 1 ? "Already playing it" : `All ${impact.cabs.length} already play it`;
  }
  return impact.cabs.length === 1 ? "Already set to play it" : "Already set to play it, no change";
}

/**
 * Where a video is set to play, in words, consistently everywhere (Videos, the video screen, the
 * change flow). `live` is true only when at least one cab plays it: a video chosen for a group
 * with no cabs, or for all cabs while there are none, is set but not on any screen.
 */
export function placeWords(liveOn: { fleet: boolean; groups: { name: string }[]; cabCount: number }) {
  const { fleet, groups, cabCount: count } = liveOn;
  if (!fleet && groups.length === 0 && count === 0) return null;
  const where = fleet ? "all cabs" : groups.length ? groups.map((group) => group.name).join(", ") : null;
  if (count === 0) {
    const text = fleet
      ? "Set for all cabs · no cab follows it right now"
      : `Set for ${where} · no cabs in ${groups.length === 1 ? "that group" : "those groups"} yet`;
    return { text, live: false };
  }
  if (fleet) return { text: `Playing on all cabs · ${cabCount(count)}`, live: true };
  if (where) return { text: `Playing in ${where} · ${cabCount(count)}`, live: true };
  return { text: `Playing on ${cabCount(count)}`, live: true };
}

export function encodeTarget(target: AssignTarget) {
  if (target.type === "fleet") return "fleet";
  if (target.type === "group") return `group:${target.groupId}`;
  return `cab:${target.deviceId}`;
}

export function decodeTarget(value: string | null): AssignTarget | null {
  if (!value) return null;
  if (value === "fleet") return { type: "fleet" };
  const [kind, id] = value.split(":");
  if (kind === "group" && id) return { type: "group", groupId: id };
  if (kind === "cab" && id) return { type: "cab", deviceId: id };
  return null;
}

/**
 * After a change got no answer: does the server's current state show it was applied? `loopId`
 * null means "go back" (a group following all cabs, or a cab following its group).
 */
export function changeIsInPlace(overview: Overview, target: AssignTarget, loopId: string | null) {
  if (target.type === "fleet") return Boolean(loopId && overview.fleetLoop?.id === loopId);
  if (target.type === "group") {
    const group = overview.groups.find((item) => item.id === target.groupId);
    if (!group) return false;
    return loopId === null ? group.followsFleet : !group.followsFleet && group.loop?.id === loopId;
  }
  const cab = overview.cabs.find((item) => item.id === target.deviceId);
  if (!cab) return false;
  return loopId === null ? cab.expectedSource !== "cab" : cab.expectedSource === "cab" && cab.expected?.id === loopId;
}

/**
 * The cab's mobile signal in words. A modem reports dBm (negative); a box without one reports a
 * 0-100 quality percentage through NetworkManager (positive). Firmware 1.2.0 sends `signalPercent`
 * separately.
 */
export function signalWords(signalStrength: number | null, signalPercent?: number | null) {
  const percent =
    typeof signalPercent === "number" ? signalPercent : signalStrength !== null && signalStrength > 0 && signalStrength <= 100 ? signalStrength : null;
  if (percent !== null) {
    const label = percent >= 70 ? "Strong" : percent >= 45 ? "Good" : percent >= 25 ? "Weak" : "Very weak";
    return `${label} (${Math.round(percent)}%)`;
  }
  if (signalStrength === null || signalStrength >= 0) return "Unknown";
  const dbm = signalStrength;
  const label = dbm >= -75 ? "Strong" : dbm >= -90 ? "Good" : dbm >= -105 ? "Weak" : "Very weak";
  return `${label} (${dbm} dBm)`;
}

