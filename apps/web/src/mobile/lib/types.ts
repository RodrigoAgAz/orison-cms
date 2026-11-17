// Client-side shapes of the mobile JSON API (/api/m/*). Mirrors the types in src/lib/mobile.ts.

export type LoopRef = { id: string; name: string; posterUrl: string | null };

export type LoopSummary = {
  id: string;
  name: string;
  status: "DRAFT" | "REVIEW" | "PUBLISHING" | "PUBLISHED" | "ARCHIVED";
  processing: {
    state: "processing" | "ready" | "failed";
    error: string | null;
    /** Queued behind another upload (one is prepared at a time). */
    waiting: boolean;
    queuedBehind: number;
  };
  durationMs: number | null;
  posterUrl: string | null;
  videoUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  source: "upload" | "builder";
  liveOn: {
    fleet: boolean;
    groups: { id: string; name: string }[];
    cabCount: number;
    /** Cabs that last reported playing it (a cab whose update fails still shows its old video). */
    onScreens?: number;
  };
};

export type CabLocation = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  source: "gps" | "cell";
  at: string;
};

export type CabStatus = "online" | "updating" | "offline" | "paused" | "inactive";

export type CabSummary = {
  id: string;
  serialNumber: string;
  label: string;
  driverName: string | null;
  group: { id: string; name: string } | null;
  status: CabStatus;
  playerStatus: "journey" | "silent" | "idle" | "disabled" | "fallback" | "error" | "unknown";
  lastSeenAt: string | null;
  playing: LoopRef | null;
  expected: LoopRef | null;
  expectedSource: "cab" | "group" | "fleet" | null;
  isUpToDate: boolean;
  uptimeSeconds: number | null;
  onlineSince: string | null;
  hoursOnlineToday: number;
  inServiceSince: string;
  location: CabLocation | null;
  isPaused: boolean;
  pausedReason: string | null;
  /** This cab's own screen is paused. */
  cabPaused: boolean;
  /** Every screen is paused from the desktop site. */
  fleetPaused: boolean;
  /** Worst-case minutes for this cab to act on a change (depends on its software version). */
  changeLagMinutes: number;
  /** Seconds on since London midnight (hoursOnlineToday is rounded to a tenth of an hour). */
  secondsOnlineToday?: number;
  /** The cab plays its built-in standby video (a new box, or one that lost its video). */
  playingBuiltIn?: boolean;
  /** What its equipment reports about where it is (latest heartbeat). */
  positionReporting?: "gps" | "cell" | "none" | "unknown";
  /** How journeys start, once the cab reports it. */
  playbackTrigger?: "gpio" | "keyboard" | "always" | null;
  /** The cab plays for passenger journeys, so passenger wording applies. */
  reportsJourneys?: boolean;
  /** Fine-grained player state (firmware 1.2.0+): "SAFETY" while the safety message plays. */
  playerState?: string | null;
  /** How its content update stands. "failing"/"downloading" come from firmware 1.2.0+. */
  sync?: {
    state: "failing" | "downloading" | "waiting" | "current" | "unknown";
    error: string | null;
    since: string | null;
    nextRetryAt: string | null;
    lastSyncedAt: string | null;
    failedLoop: { id: string; name: string } | null;
  };
};

export type CabDetail = CabSummary & {
  /** dBm from the modem, or (older firmware without a modem) a 0-100 percentage. */
  signalStrength: number | null;
  /** 0-100 signal quality, when that is what the cab reports. */
  signalPercent?: number | null;
  /** dBm, when the cab's modem reports it. */
  signalDbm?: number | null;
  /** When the technical figures were reported. */
  reportedAt?: string | null;
  networkType: string | null;
  storageFreeMb: number | null;
  cpuTemp: number | null;
  firmwareVersion: string | null;
  notes: string | null;
  override: { id: string; name: string } | null;
  trail: CabLocation[];
  timeline: { start: string; end: string }[];
};

export type Role = "ADMIN" | "EDITOR";

/**
 * GET /api/auth/me. When nobody is signed in and the phone app is open (the default), this is the
 * shared identity actions are recorded under: `signedIn: false`, no email, role EDITOR.
 */
export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  signedIn: boolean;
  /** PHONE_APP_REQUIRE_SIGN_IN is set on the server: the phone app needs sign-in. */
  signInRequired: boolean;
};

export type GroupSummary = {
  id: string;
  name: string;
  cabCount: number;
  onlineCount: number;
  followsFleet: boolean;
  loop: LoopRef | null;
};

export type Overview = {
  generatedAt: string;
  user: { id: string; name: string; email: string | null; role: Role; signedIn: boolean };
  counts: { total: number; online: number; updating: number; offline: number; paused: number };
  fleetLoop: LoopSummary | null;
  fleetPaused: boolean;
  /** Worst case across all cabs. */
  changeLagMinutes: number;
  changeLag: { minMinutes: number; maxMinutes: number; slowCabs: number };
  groups: GroupSummary[];
  cabs: CabSummary[];
  recentActivity: { id: string; type: string; message: string; createdAt: string }[];
};

export type TeamMember = { id: string; name: string; email: string; role: Role; createdAt: string };

export type AssignTarget =
  | { type: "fleet" }
  | { type: "group"; groupId: string }
  | { type: "cab"; deviceId: string };
