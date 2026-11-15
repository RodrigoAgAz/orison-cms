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

export function passengerLine(cab: Pick<CabSummary, "playerStatus" | "status">) {
  if (!isSwitchedOn(cab)) return null;
  switch (cab.playerStatus) {
    case "journey":
      return "Passenger on board";
    case "silent":
      return "Passenger turned the sound off";
    case "idle":
      return "Waiting for a passenger";
    case "disabled":
      return "Screen turned off in the cab";
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
    return cab.playing ? quoted(cab.playing.name) : "Nothing yet";
  }
  if (cab.status === "updating") return `Switching to ${quoted(cab.expected.name)}`;
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
  alreadyPlaying: CabSummary[];
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
  return {
    cabs,
    on: cabs.filter(isSwitchedOn),
    off: cabs.filter((cab) => cab.status === "offline"),
    paused: cabs.filter((cab) => cab.status === "paused"),
    alreadyPlaying: cabs.filter((cab) => cab.playing?.id === resultId && cab.expected?.id === resultId),
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
