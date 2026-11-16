// Pure parsing of device heartbeat location payloads and Quectel AT+QENG="servingcell" output.

export type CellRadio = "lte" | "wcdma" | "gsm";

export type ServingCell = {
  radio: CellRadio;
  mcc: number;
  mnc: number;
  /** LAC (GSM/WCDMA) or TAC (LTE), decimal. */
  lac: number;
  /** Cell id, decimal (LTE: 28-bit E-UTRAN cell id). */
  cellId: number;
  /** RSRP (LTE), RSCP (WCDMA) or RxLev (GSM, raw) when present. */
  signal: number | null;
};

function stripToken(token: string) {
  return token.trim().replace(/^"|"$/g, "").trim();
}

function parseHex(token: string | undefined) {
  if (!token || !/^[0-9a-fA-F]+$/.test(token)) {
    return null;
  }
  const value = Number.parseInt(token, 16);
  return Number.isFinite(value) ? value : null;
}

function parseDec(token: string | undefined) {
  if (!token || !/^-?\d+$/.test(token)) {
    return null;
  }
  return Number.parseInt(token, 10);
}

function validCell(cell: ServingCell): ServingCell | null {
  if (cell.mcc < 1 || cell.mcc > 999 || cell.mnc < 0 || cell.mnc > 999) {
    return null;
  }
  if (cell.lac < 0 || cell.cellId <= 0) {
    return null;
  }
  // FFFF / FFFFFFF style placeholders mean "unknown" on Quectel modems.
  if (cell.lac === 0xffff || cell.lac === 0xfffe || cell.cellId === 0xfffffff || cell.cellId === 0xffffffff) {
    return null;
  }
  return cell;
}

/**
 * Parse one `+QENG: "servingcell",...` response (may contain several lines / the whole AT
 * transcript). Returns null when there is no camped serving cell (SEARCH, LIMSRV, 5G-only, ...).
 */
export function parseQengServingCell(raw: string | null | undefined): ServingCell | null {
  if (!raw) {
    return null;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^\+QENG:\s*(.*)$/i.exec(line);
    if (!match) {
      continue;
    }
    const fields = match[1].split(",").map(stripToken);
    if (fields[0]?.toLowerCase() !== "servingcell") {
      continue;
    }
    const rat = fields[2]?.toUpperCase();

    if (rat === "LTE") {
      // "servingcell",<state>,"LTE",<is_tdd>,<MCC>,<MNC>,<cellID>,<PCID>,<earfcn>,<band>,
      // <UL_bw>,<DL_bw>,<TAC>,<RSRP>,<RSRQ>,<RSSI>,<SINR>,<srxlev>
      const mcc = parseDec(fields[4]);
      const mnc = parseDec(fields[5]);
      const cellId = parseHex(fields[6]);
      const tac = parseHex(fields[12]);
      if (mcc === null || mnc === null || cellId === null || tac === null) {
        continue;
      }
      const cell = validCell({ radio: "lte", mcc, mnc, lac: tac, cellId, signal: parseDec(fields[13]) });
      if (cell) return cell;
      continue;
    }

    if (rat === "WCDMA" || rat === "GSM") {
      // "servingcell",<state>,"WCDMA",<MCC>,<MNC>,<LAC>,<cellID>,<uarfcn>,<PSC>,<RAC>,<RSCP>,...
      // "servingcell",<state>,"GSM",<MCC>,<MNC>,<LAC>,<cellID>,<BSIC>,<ARFCN>,<band>,<RxLev>,...
      const mcc = parseDec(fields[3]);
      const mnc = parseDec(fields[4]);
      const lac = parseHex(fields[5]);
      const cellId = parseHex(fields[6]);
      if (mcc === null || mnc === null || lac === null || cellId === null) {
        continue;
      }
      const signal = parseDec(fields[10]); // RSCP (WCDMA) / RxLev (GSM)
      const cell = validCell({ radio: rat === "WCDMA" ? "wcdma" : "gsm", mcc, mnc, lac, cellId, signal });
      if (cell) return cell;
    }
  }

  return null;
}

function toInt(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function normalizeRadio(value: unknown): CellRadio | null {
  if (typeof value !== "string") {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === "lte" || lower === "4g") return "lte";
  if (lower === "wcdma" || lower === "umts" || lower === "3g") return "wcdma";
  if (lower === "gsm" || lower === "2g") return "gsm";
  return null;
}

function cellFromFields(record: Record<string, unknown>): ServingCell | null {
  const radio = normalizeRadio(record.radio);
  const mcc = toInt(record.mcc);
  const mnc = toInt(record.mnc);
  const lac = toInt(record.lac);
  const cellId = toInt(record.cellId);
  if (!radio || mcc === null || mnc === null || lac === null || cellId === null) {
    return null;
  }
  return validCell({ radio, mcc, mnc, lac, cellId, signal: null });
}

export type GpsFix = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  fixTime: Date | null;
};

export type ParsedHeartbeatLocation = {
  gps: GpsFix | null;
  cell: ServingCell | null;
};

/**
 * Extract a GPS fix and/or serving cell from a heartbeat `location` object.
 * - `raw` (QENG text) is authoritative for the cell whenever present: old firmware sends wrong
 *   top-level fields for LTE because its parser dropped hex tokens.
 * - Without `raw`, new-firmware fields are used: `cell: {...}` (gps payload) or top-level
 *   radio/mcc/mnc/lac/cellId (cell_tower payload). Old-firmware payloads with no `radio` are ignored.
 */
export function parseHeartbeatLocation(location: unknown): ParsedHeartbeatLocation {
  if (!location || typeof location !== "object" || Array.isArray(location)) {
    return { gps: null, cell: null };
  }
  const record = location as Record<string, unknown>;

  let gps: GpsFix | null = null;
  const lat = toNumber(record.lat);
  const lng = toNumber(record.lng ?? record.lon);
  if (
    (record.method === "gps" || record.method === undefined) &&
    lat !== null &&
    lng !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  ) {
    const fixTime = typeof record.fixTime === "string" ? new Date(record.fixTime) : null;
    const accuracy = toNumber(record.accuracyM);
    gps = {
      lat,
      lng,
      accuracyM: accuracy !== null && accuracy >= 0 ? accuracy : null,
      fixTime: fixTime && !Number.isNaN(fixTime.getTime()) ? fixTime : null,
    };
  }

  let cell: ServingCell | null = null;
  if (typeof record.raw === "string" && record.raw.trim() !== "") {
    cell = parseQengServingCell(record.raw);
  } else if (record.cell && typeof record.cell === "object") {
    cell = cellFromFields(record.cell as Record<string, unknown>);
  } else {
    cell = cellFromFields(record);
  }

  return { gps, cell };
}
