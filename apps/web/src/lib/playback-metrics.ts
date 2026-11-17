// What a playback-log row is, for reporting. Advertisers are billed from these numbers, so each
// one counts only what its label says. The same rules exist twice: classifyPlayback() for code and
// tests (test/playback-metrics.test.ts), PLAYBACK_KIND_SQL for aggregating in the database. Keep
// them identical: when changing either, evaluate the SQL over every combination of eventName,
// contentType, playbackType and mode and compare with classifyPlayback (done for this version: 504
// combinations, no difference).
//
// Rows from firmware 1.0.0/1.1.0 (no eventId):
//   - a still shown while idle or muted is logged as contentType ADVERTISEMENT, type ADVERTISEMENT
//     with mode "idle" or "silent" (once a minute), so mode is what tells a still from a video;
//   - video plays during a journey have mode "journey" and are logged as complete when they START,
//     so their completion is not a measurement;
//   - the safety message is type SAFETY_MESSAGE; journey markers have event JOURNEY_START/END.
// Rows from firmware 1.2.0+ (eventId set): stills are type STATIC_IMAGE with contentType null,
// mode "continuous" means played without passenger detection, and durationMs/completedFull are
// measured.

export type PlaybackKind =
  | "advert" // a video advert played to a passenger (journey) or in continuous mode
  | "filler" // a filler video, same modes
  | "still" // a still image on screen (idle or muted), counted as "still showings"
  | "safety"
  | "journey_start"
  | "journey_end"
  | "other";

export type ClassifiableRow = {
  eventName: string | null;
  contentType: string | null;
  playbackType: string | null;
  mode: string | null;
};

const SAFETY_TYPES = new Set(["SAFETY", "SAFETY_MESSAGE"]);
const STILL_TYPES = new Set(["STATIC_IMAGE"]);
const STILL_MODES = new Set(["idle", "silent"]);
const PLAYING_MODES = new Set(["journey", "continuous"]);

export function classifyPlayback(row: ClassifiableRow): PlaybackKind {
  if (row.eventName === "JOURNEY_START") {
    return "journey_start";
  }
  if (row.eventName === "JOURNEY_END") {
    return "journey_end";
  }
  if (row.eventName) {
    return "other";
  }
  if (row.playbackType && SAFETY_TYPES.has(row.playbackType)) {
    return "safety";
  }
  if ((row.playbackType && STILL_TYPES.has(row.playbackType)) || (row.mode && STILL_MODES.has(row.mode))) {
    return "still";
  }
  if (row.mode && PLAYING_MODES.has(row.mode)) {
    if (row.contentType === "ADVERTISEMENT") {
      return "advert";
    }
    if (row.contentType === "FILLER") {
      return "filler";
    }
  }
  return "other";
}

/** SQL twin of classifyPlayback over "PlaybackLog" columns (optionally qualified by an alias). */
export function playbackKindSql(alias?: string) {
  const c = (column: string) => (alias ? `${alias}."${column}"` : `"${column}"`);
  return `CASE
    WHEN ${c("eventName")} = 'JOURNEY_START' THEN 'journey_start'
    WHEN ${c("eventName")} = 'JOURNEY_END' THEN 'journey_end'
    WHEN ${c("eventName")} IS NOT NULL THEN 'other'
    WHEN ${c("playbackType")} IN ('SAFETY', 'SAFETY_MESSAGE') THEN 'safety'
    WHEN ${c("playbackType")} = 'STATIC_IMAGE' OR ${c("mode")} IN ('idle', 'silent') THEN 'still'
    WHEN ${c("mode")} IN ('journey', 'continuous') AND ${c("contentType")} = 'ADVERTISEMENT' THEN 'advert'
    WHEN ${c("mode")} IN ('journey', 'continuous') AND ${c("contentType")} = 'FILLER' THEN 'filler'
    ELSE 'other'
  END`;
}

export const PLAYBACK_KIND_SQL = playbackKindSql();

/** London calendar date of "playedAt" (stored as UTC without a zone). */
export function londonDaySql(alias?: string) {
  const column = alias ? `${alias}."playedAt"` : `"playedAt"`;
  return `((${column} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date`;
}

export const KIND_LABELS: Record<PlaybackKind, string> = {
  advert: "advert_play",
  filler: "filler_play",
  still: "still_showing",
  safety: "safety_message",
  journey_start: "journey_start",
  journey_end: "journey_end",
  other: "other",
};

/** One aggregated row: plays of one kind on one London day (and for adverts, one asset). */
export type DailyKindRow = {
  day: string; // yyyy-mm-dd, London
  kind: PlaybackKind;
  plays: number;
  /** Rows with an eventId (firmware 1.2.0+): their duration and completion are measured. */
  measured: number;
  measuredCompleted: number;
  /** Sum of durationMs (used for journey_end: the journey length). */
  durationMsSum: number;
  /** Plays in mode "journey" (adverts only: for "advert plays per journey"). */
  journeyModePlays: number;
};

export type PlaybackSummary = {
  series: Array<{ day: string; advertPlays: number; stillShowings: number }>;
  totals: {
    advertPlays: number;
    advertPlaysToday: number;
    stillShowings: number;
    stillShowingsToday: number;
    fillerPlays: number;
    safetyPlays: number;
  };
  journeys: {
    today: number;
    week: number;
    month: number;
    averageDurationMs: number | null;
    /** Advert plays during passenger journeys / journeys; null when there were no journeys. */
    advertPlaysPerJourney: number | null;
  };
  /** Completion among measured advert plays; null when none carried measured data. */
  completion: { measuredPlays: number; completedPlays: number; ratePercent: number | null };
  busiestDay: { day: string; advertPlays: number } | null;
};

/**
 * Reduce per-day rows to the dashboard/analytics figures. `seriesKeys` are the chart days;
 * journeys this month may reach back before the chart, so rows for those days are included too.
 */
export function summarizePlayback(
  rows: DailyKindRow[],
  periods: { todayKey: string; weekStartKey: string; monthStartKey: string; seriesKeys: string[] },
): PlaybackSummary {
  const seriesStart = periods.seriesKeys[0] ?? periods.todayKey;
  const byDay = new Map(periods.seriesKeys.map((day) => [day, { day, advertPlays: 0, stillShowings: 0 }]));
  const totals = {
    advertPlays: 0,
    advertPlaysToday: 0,
    stillShowings: 0,
    stillShowingsToday: 0,
    fillerPlays: 0,
    safetyPlays: 0,
  };
  const journeys = { today: 0, week: 0, month: 0 };
  let journeyEnds = 0;
  let journeyDurationSum = 0;
  let journeyStartsInSeries = 0;
  let journeyAdvertPlays = 0;
  let measuredPlays = 0;
  let completedPlays = 0;

  for (const row of rows) {
    const inSeries = row.day >= seriesStart && row.day <= periods.todayKey;
    const isToday = row.day === periods.todayKey;
    if (row.kind === "journey_start") {
      if (row.day >= periods.monthStartKey) journeys.month += row.plays;
      if (row.day >= periods.weekStartKey) journeys.week += row.plays;
      if (isToday) journeys.today += row.plays;
      if (inSeries) journeyStartsInSeries += row.plays;
      continue;
    }
    if (!inSeries) {
      continue;
    }
    const point = byDay.get(row.day);
    switch (row.kind) {
      case "advert":
        totals.advertPlays += row.plays;
        if (isToday) totals.advertPlaysToday += row.plays;
        if (point) point.advertPlays += row.plays;
        measuredPlays += row.measured;
        completedPlays += row.measuredCompleted;
        journeyAdvertPlays += row.journeyModePlays;
        break;
      case "still":
        totals.stillShowings += row.plays;
        if (isToday) totals.stillShowingsToday += row.plays;
        if (point) point.stillShowings += row.plays;
        break;
      case "filler":
        totals.fillerPlays += row.plays;
        break;
      case "safety":
        totals.safetyPlays += row.plays;
        break;
      case "journey_end":
        journeyEnds += row.plays;
        journeyDurationSum += row.durationMsSum;
        break;
      default:
        break;
    }
  }

  const series = periods.seriesKeys.map((day) => byDay.get(day)!);
  const busiest = series.reduce<{ day: string; advertPlays: number } | null>(
    (best, point) => (point.advertPlays > (best?.advertPlays ?? 0) ? { day: point.day, advertPlays: point.advertPlays } : best),
    null,
  );

  return {
    series,
    totals,
    journeys: {
      ...journeys,
      averageDurationMs: journeyEnds === 0 ? null : Math.round(journeyDurationSum / journeyEnds),
      advertPlaysPerJourney:
        journeyStartsInSeries === 0 ? null : Number((journeyAdvertPlays / journeyStartsInSeries).toFixed(1)),
    },
    completion: {
      measuredPlays,
      completedPlays,
      ratePercent: measuredPlays === 0 ? null : Math.round((completedPlays / measuredPlays) * 100),
    },
    busiestDay: busiest,
  };
}

/** Per-advert completion: a percentage only when some plays carried measured data. */
export function completionPercent(measured: number, completed: number) {
  return measured === 0 ? null : Math.round((completed / measured) * 100);
}
