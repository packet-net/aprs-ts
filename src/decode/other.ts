// Status reports, telemetry reports, queries, capabilities, NMEA, raw weather, user-defined and
// test data, Agrelo DF, Maidenhead beacons.

import type {
  AgreloDf,
  AprsTimestamp,
  Capabilities,
  Capability,
  MaidenheadBeacon,
  NmeaSentence,
  Query,
  RawWeather,
  RawWeatherFormat,
  StatusReport,
  TelemetryReport,
  TestData,
  UserDefined,
} from '../types.js';
import type { DecodeContext } from './context.js';
import { isSymbolTable, timestampValid } from './positioned.js';

const LOCATOR6 = /^[A-Ra-r]{2}[0-9]{2}[A-Xa-x]{2}/;
const LOCATOR4 = /^[A-Ra-r]{2}[0-9]{2}/;

function printableCode(c: string | undefined): boolean {
  if (c === undefined) return false;
  const v = c.charCodeAt(0);
  return v >= 0x21 && v <= 0x7e;
}

/** `>`: a status report. */
export function decodeStatus(ctx: DecodeContext, s: string): StatusReport {
  let body = s.slice(1);
  const out: { -readonly [K in keyof StatusReport]: StatusReport[K] } = { type: 'status' };
  const ts = /^([0-9]{2})([0-9]{2})([0-9]{2})z/.exec(body);
  if (ts) {
    const timestamp: AprsTimestamp = { kind: 'dhm-zulu', day: Number(ts[1]), hour: Number(ts[2]), minute: Number(ts[3]) };
    if (!timestampValid(timestamp)) ctx.tolerate('invalid-timestamp');
    out.timestamp = timestamp;
    body = body.slice(7);
  } else {
    let locatorLength = 0;
    if (LOCATOR6.test(body)) {
      if (isSymbolTable(body[6]) && printableCode(body[7])) locatorLength = 6;
    } else if (LOCATOR4.test(body) && isSymbolTable(body[4]) && printableCode(body[5])) {
      locatorLength = 4;
    }
    if (locatorLength > 0) {
      out.locator = body.slice(0, locatorLength).toUpperCase();
      out.symbol = { table: body[locatorLength]!, code: body[locatorLength + 1]! };
      body = body.slice(locatorLength + 2);
      if (body.length > 0) {
        if (body[0] === ' ') body = body.slice(1);
        else ctx.tolerate('missing-space-after-locator');
      }
    }
  }
  // The ERP codes run 1-9, : to @, then A-K; there is no 0 (APRS12c ch. 16).
  const beam = /\^([0-9A-Z])([1-9:;<=>?@A-K])$/.exec(body);
  if (beam) {
    out.beam = { headingCode: beam[1]!, powerCode: beam[2]! };
    body = body.slice(0, beam.index);
  }
  if (body.length > 0) {
    const text = ctx.text(body);
    if (text.length > 0) out.text = text;
  }
  return out;
}

const TELEMETRY_VALUE_RE = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;

/** `T`: a telemetry report. */
export function decodeTelemetry(ctx: DecodeContext, s: string): TelemetryReport {
  if (!s.startsWith('T#')) ctx.fail('invalid-telemetry');
  let j: number;
  let sequence: string;
  if (s.startsWith('MIC', 2)) {
    sequence = 'MIC';
    j = 5;
    if (s[j] === ',') j++;
  } else {
    const m = /^([A-Za-z0-9]+),/.exec(s.slice(2));
    if (!m) ctx.fail('invalid-telemetry');
    sequence = m[1]!;
    j = 2 + m[0].length;
  }
  const analog: (number | null)[] = [];
  const analogText: (string | null)[] = [];
  let ended = false;
  while (analog.length < 5) {
    const comma = s.indexOf(',', j);
    const end = comma < 0 ? s.length : comma;
    const v = s.slice(j, end);
    if (v.length === 0) {
      analog.push(null);
      analogText.push(null);
    } else if (TELEMETRY_VALUE_RE.test(v)) {
      analog.push(Number(v));
      analogText.push(v);
    } else {
      ctx.fail('invalid-telemetry');
    }
    if (comma < 0) {
      ended = true;
      j = s.length;
      break;
    }
    j = comma + 1;
  }
  const out: { -readonly [K in keyof TelemetryReport]: TelemetryReport[K] } = {
    type: 'telemetry',
    sequence,
    analog,
    analogText,
  };
  if (analog.length < 5 || ended) {
    ctx.tolerate('invalid-telemetry');
    return out;
  }
  const bits = s.slice(j, j + 8);
  if (!/^[01]{8}$/.test(bits)) {
    ctx.tolerate('invalid-telemetry');
    const rest = s.slice(j);
    if (rest.length > 0) out.comment = ctx.text(rest);
    return out;
  }
  out.bits = bits;
  const comment = s.slice(j + 8);
  if (comment.length > 0) out.comment = ctx.text(comment);
  return out;
}

const FOOTPRINT_NUMBER = '[0-9]+\\.?[0-9]*|\\.[0-9]+';
const FOOTPRINT_VALUE = `( ?(?:${FOOTPRINT_NUMBER})|-(?:${FOOTPRINT_NUMBER}))`;
const FOOTPRINT_RE = new RegExp(`^${FOOTPRINT_VALUE},${FOOTPRINT_VALUE},([0-9]{4})$`);

/** `?`: a general query. */
export function decodeQuery(ctx: DecodeContext, s: string): Query {
  const m = /^\?([A-Z]+)\?(.*)$/s.exec(s);
  if (!m) ctx.fail('invalid-general-query');
  const out: { -readonly [K in keyof Query]: Query[K] } = { type: 'query', queryType: m[1]! };
  const rest = m[2]!;
  if (rest.length > 0) {
    // Decimal degrees, each a number as a telemetry value is (`-.1715`), a positive one with or
    // without a leading space, and a 4-digit radius.
    const f = FOOTPRINT_RE.exec(rest);
    if (!f) ctx.fail('invalid-general-query');
    const latitude = Number(f[1]);
    const longitude = Number(f[2]);
    // A footprint is a real place (vectors interpretations.md).
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) ctx.fail('invalid-general-query');
    out.footprint = { latitude, longitude, radiusMiles: Number(f[3]) };
  }
  return out;
}

/** Drops U+0020 spaces, and no other character, from both ends. */
function trimSpaces(text: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && text[a] === ' ') a++;
  while (b > a && text[b - 1] === ' ') b--;
  return text.slice(a, b);
}

/** A control character: below U+0020, or U+007F. */
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** `<`: station capabilities. */
export function decodeCapabilities(ctx: DecodeContext, s: string): Capabilities {
  const text = ctx.text(s.slice(1));
  const capabilities: Capability[] = [];
  let freeText = false;
  for (const raw of text.split(',')) {
    // Spaces around an item, a token or a value are padding; nothing else is (vectors
    // interpretations.md, "Station capabilities: items, tokens and values").
    const item = trimSpaces(raw);
    if (item.length === 0) continue; // empty items are skipped
    const eq = item.indexOf('=');
    const token = eq < 0 ? item : trimSpaces(item.slice(0, eq));
    const value = eq < 0 ? undefined : trimSpaces(item.slice(eq + 1));
    if (token.length === 0 || token.includes(' ') || CONTROL_RE.test(token)) freeText = true;
    if (value !== undefined && CONTROL_RE.test(value)) freeText = true;
    capabilities.push(value === undefined ? [token] : [token, value]);
  }
  if (capabilities.length === 0) ctx.fail('invalid-capabilities');
  if (freeText) ctx.tolerate('free-text-capabilities');
  return { type: 'capabilities', capabilities };
}

/** A coordinate: at least three digits before an optional `.` and fraction, the last two minutes. */
function nmeaDegrees(value: string | undefined, hemisphere: string | undefined, limit: number): number | undefined {
  if (value === undefined || hemisphere === undefined) return undefined;
  const m = /^([0-9]+)([0-9]{2}(?:\.[0-9]*)?)$/.exec(value);
  if (!m) return undefined;
  const degrees = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes >= 60) return undefined;
  const v = degrees + minutes / 60;
  if (v > limit) return undefined;
  if (hemisphere === (limit === 90 ? 'S' : 'W')) return v === 0 ? 0 : -v;
  if (hemisphere === (limit === 90 ? 'N' : 'E')) return v;
  return undefined;
}

/** `hhmmss` with an optional fraction, as `HH:MM:SS` and the fraction as sent, less trailing zeros. */
function nmeaTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^([0-9]{2})([0-9]{2})([0-9]{2})(?:\.([0-9]*))?$/.exec(value);
  if (!m) return undefined;
  if (Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return undefined;
  let t = `${m[1]}:${m[2]}:${m[3]}`;
  const fraction = (m[4] ?? '').replace(/0+$/, '');
  if (fraction.length > 0) t += `.${fraction}`;
  return t;
}

/**
 * An optional `-`, then digits with an optional `.` and fraction. NMEA 0183 makes leading zeros
 * optional, so a number may start with its decimal point (`.30`).
 */
function nmeaNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value)) return undefined;
  return Number(value);
}

const NMEA_ADDRESS_RE = /^(?:[A-Z0-9]{5}|P[A-Z0-9]{3,})$/;

/** An NMEA 0183 sentence taken apart. */
export interface NmeaParts {
  /** The sentence, up to and including any `*hh` checksum. */
  sentence: string;
  /** The comma-separated fields before any checksum, the address field first. */
  fields: string[];
  /** Whether the sentence has a checksum. */
  hasChecksum: boolean;
  /** Whether the checksum matches; true when there is none. */
  checksumOk: boolean;
  /** Whatever follows the checksum. */
  rest: string;
}

/**
 * Takes the text after `$` apart as an NMEA 0183 sentence (vectors interpretations.md, "What $
 * text is an NMEA sentence"): printable ASCII, an address field of five upper-case letters or
 * digits (or `P` and three or more), at least one field, no `$`, and no `*` but the one that
 * starts a checksum of two hex digits, which ends the sentence. `undefined` when it is not one.
 */
export function splitNmea(text: string): NmeaParts | undefined {
  const star = text.indexOf('*');
  const hasChecksum = star >= 0;
  if (hasChecksum && !/^[0-9A-Fa-f]{2}$/.test(text.slice(star + 1, star + 3))) return undefined;
  const body = hasChecksum ? text.slice(0, star) : text;
  if (!/^[\x20-\x7e]*$/.test(body) || body.includes('$')) return undefined;
  const fields = body.split(',');
  if (fields.length < 2 || !NMEA_ADDRESS_RE.test(fields[0]!)) return undefined;
  const end = hasChecksum ? star + 3 : text.length;
  let checksumOk = true;
  if (hasChecksum) {
    let x = 0;
    for (let k = 0; k < body.length; k++) x ^= body.charCodeAt(k);
    checksumOk = x === parseInt(text.slice(star + 1, star + 3), 16);
  }
  return { sentence: text.slice(0, end), fields, hasChecksum, checksumOk, rest: text.slice(end) };
}

/** `$`: raw NMEA, or Ultimeter raw weather (`$ULTW`). */
export function decodeDollar(ctx: DecodeContext, s: string): NmeaSentence | RawWeather {
  if (s.startsWith('$ULTW')) return decodeRawWeather(ctx, s.slice(5), 'ultimeter-packet');
  ctx.info('obsolete-format');
  // The structure is checked before the checksum.
  const parts = splitNmea(s.slice(1));
  if (!parts) return ctx.fail('invalid-nmea');
  if (!parts.checksumOk) ctx.fail('nmea-checksum-mismatch');
  const f = parts.fields;
  const out: { -readonly [K in keyof NmeaSentence]: NmeaSentence[K] } = { type: 'nmea', sentence: parts.sentence };
  if (parts.hasChecksum) out.hasChecksum = true;
  const set = <K extends keyof NmeaSentence>(key: K, value: NmeaSentence[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  // A position needs both coordinates.
  const position = (lat: number, lon: number): void => {
    const latitude = nmeaDegrees(f[lat], f[lat + 1], 90);
    const longitude = nmeaDegrees(f[lon], f[lon + 1], 180);
    if (latitude === undefined || longitude === undefined) return;
    out.latitude = latitude;
    out.longitude = longitude;
  };
  // Only an approved address (five characters, not P) has a sentence formatter.
  const address = f[0]!;
  const formatter = address.length === 5 && address[0] !== 'P' ? address.slice(2) : '';
  switch (formatter) {
    case 'GGA': {
      position(2, 4);
      if (f[6] !== undefined && /^[0-9]$/.test(f[6])) out.fix = f[6] === '0' ? 'invalid' : 'valid';
      set('altitudeM', nmeaNumber(f[9]));
      set('time', nmeaTime(f[1]));
      break;
    }
    case 'GLL': {
      position(1, 3);
      set('time', nmeaTime(f[5]));
      if (f[6] === 'A') out.fix = 'valid';
      else if (f[6] === 'V') out.fix = 'invalid';
      break;
    }
    case 'RMC': {
      set('time', nmeaTime(f[1]));
      if (f[2] === 'A') out.fix = 'valid';
      else if (f[2] === 'V') out.fix = 'invalid';
      position(3, 5);
      set('speedKnots', nmeaNumber(f[7]));
      set('courseDegrees', nmeaNumber(f[8]));
      break;
    }
    case 'VTG': {
      set('courseDegrees', nmeaNumber(f[1]));
      set('speedKnots', nmeaNumber(f[5]));
      break;
    }
    case 'WPL': {
      position(1, 3);
      if (f[5] !== undefined && f[5].length > 0) out.waypoint = f[5];
      break;
    }
  }
  // Text after the checksum is a comment, kept as sent.
  if (parts.rest.length > 0) out.comment = ctx.text(parts.rest);
  return out;
}

/** Raw weather station data, kept as text. */
export function decodeRawWeather(ctx: DecodeContext, data: string, format: RawWeatherFormat): RawWeather {
  ctx.info('obsolete-format');
  if (!/^[\x20-\x7e]*$/.test(data)) ctx.fail('invalid-weather');
  return data.length > 0 ? { type: 'raw-weather', format, data } : { type: 'raw-weather', format };
}

/** `{`: user-defined data, kept as bytes. */
export function decodeUserDefined(ctx: DecodeContext, s: string): UserDefined {
  if (s.length < 3) ctx.fail('invalid-user-defined');
  const data = s.slice(3);
  const out: { -readonly [K in keyof UserDefined]: UserDefined[K] } = {
    type: 'user-defined',
    userId: s[1]!,
    packetType: s[2]!,
  };
  if (data.length > 0) out.data = data;
  return out;
}

/** `,`: invalid or test data. */
export function decodeTest(ctx: DecodeContext, s: string): TestData {
  const data = ctx.text(s.slice(1));
  return data.length > 0 ? { type: 'test', data } : { type: 'test' };
}

/** `%`: an Agrelo DFJr / MicroFinder report. */
export function decodeAgrelo(ctx: DecodeContext, s: string): AgreloDf {
  // Exactly %, a bearing of 000 to 360, / and a quality digit (vectors interpretations.md).
  const m = /^%([0-9]{3})\/([0-9])$/.exec(s);
  if (!m || Number(m[1]) > 360) return ctx.fail('invalid-agrelo-df');
  return { type: 'agrelo-df', bearingDegrees: Number(m[1]), quality: Number(m[2]) };
}

/** `[`: a Maidenhead locator beacon. */
export function decodeMaidenhead(ctx: DecodeContext, s: string): MaidenheadBeacon {
  ctx.info('obsolete-format');
  const m = /^\[([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\]/.exec(s);
  if (!m) ctx.fail('invalid-locator');
  const out: { -readonly [K in keyof MaidenheadBeacon]: MaidenheadBeacon[K] } = {
    type: 'maidenhead-beacon',
    locator: m[1]!.toUpperCase(),
  };
  const rest = s.slice(m[0].length);
  if (rest.length > 0) out.comment = ctx.text(rest);
  return out;
}
