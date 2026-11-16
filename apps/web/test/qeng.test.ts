import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseHeartbeatLocation, parseQengServingCell } from "../src/lib/qeng";

const LTE = '+QENG: "servingcell","NOCONN","LTE","FDD",234,10,1A2D003,215,1617,3,5,5,3039,-95,-11,-63,12,40';
const WCDMA = '+QENG: "servingcell","NOCONN","WCDMA",234,15,1F4A,8C3F21,10813,276,1,-82,-6,-,-,-,-,-';
const GSM = '+QENG: "servingcell","NOCONN","GSM",234,30,0BB8,4E21,12,81,0,-75,255,255,0,30,30,1,-,-,-,-,-,-,-,-,-,"-"';

describe("parseQengServingCell", () => {
  it("LTE: cellID and TAC are hex", () => {
    assert.deepEqual(parseQengServingCell(LTE), {
      radio: "lte", mcc: 234, mnc: 10, lac: 0x3039, cellId: 0x1a2d003, signal: -95,
    });
  });
  it("WCDMA", () => {
    assert.deepEqual(parseQengServingCell(WCDMA), {
      radio: "wcdma", mcc: 234, mnc: 15, lac: 0x1f4a, cellId: 0x8c3f21, signal: -82,
    });
  });
  it("GSM", () => {
    const cell = parseQengServingCell(GSM);
    assert.equal(cell?.radio, "gsm");
    assert.equal(cell?.lac, 3000);
    assert.equal(cell?.cellId, 20001);
  });
  it("finds the servingcell line inside a full AT transcript", () => {
    assert.equal(parseQengServingCell(`AT+QENG="servingcell"\r\n${LTE}\r\n\r\nOK\r\n`)?.cellId, 0x1a2d003);
  });
  it("returns null without a camped cell", () => {
    assert.equal(parseQengServingCell('+QENG: "servingcell","SEARCH"'), null);
    assert.equal(parseQengServingCell('+QENG: "servingcell","LIMSRV","LTE","FDD",234,10,FFFFFFF,0,0,0,0,0,FFFF,-140,-20,-120,0,0'), null);
    assert.equal(parseQengServingCell("OK"), null);
    assert.equal(parseQengServingCell(""), null);
    assert.equal(parseQengServingCell(null), null);
  });
});

describe("parseHeartbeatLocation", () => {
  it("old firmware: re-parses raw and ignores the wrong top-level fields", () => {
    const parsed = parseHeartbeatLocation({
      method: "cell_tower", mcc: "234", mnc: "10", lac: "215", cellId: "1617", signalStrength: -95, raw: LTE,
    });
    assert.equal(parsed.gps, null);
    assert.deepEqual(
      { lac: parsed.cell?.lac, cellId: parsed.cell?.cellId, radio: parsed.cell?.radio },
      { lac: 12345, cellId: 27447299, radio: "lte" },
    );
  });
  it("old firmware without raw and without radio: no cell", () => {
    assert.equal(parseHeartbeatLocation({ method: "cell_tower", mcc: "234", mnc: "10", lac: "1", cellId: "2" }).cell, null);
  });
  it("new firmware cell_tower without raw uses decimal fields", () => {
    const parsed = parseHeartbeatLocation({ method: "cell_tower", radio: "lte", mcc: 234, mnc: 10, lac: 12345, cellId: 27447555 });
    assert.deepEqual(parsed.cell, { radio: "lte", mcc: 234, mnc: 10, lac: 12345, cellId: 27447555, signal: null });
  });
  it("new firmware gps payload", () => {
    const parsed = parseHeartbeatLocation({
      method: "gps", lat: 51.5072, lng: -0.1276, accuracyM: 12, hdop: 1.1, fixTime: "2026-11-15T10:00:00Z",
      cell: { radio: "lte", mcc: 234, mnc: 10, lac: 12345, cellId: 27447555 },
    });
    assert.deepEqual(parsed.gps, { lat: 51.5072, lng: -0.1276, accuracyM: 12, fixTime: new Date("2026-11-15T10:00:00Z") });
    assert.equal(parsed.cell?.cellId, 27447555);
  });
  it("rejects null island and garbage", () => {
    assert.equal(parseHeartbeatLocation({ method: "gps", lat: 0, lng: 0 }).gps, null);
    assert.deepEqual(parseHeartbeatLocation("nope"), { gps: null, cell: null });
    assert.deepEqual(parseHeartbeatLocation(null), { gps: null, cell: null });
  });
});
