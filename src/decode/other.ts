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
  const beam = /\^([0-9A-Z])([0-9:;<=>?@A-K])$/.exec(body);
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

/** `?`: a general query. */
export function decodeQuery(ctx: DecodeContext, s: string): Query {
  const m = /^\?([A-Z]+)\?(.*)$/s.exec(s);
  if (!m) ctx.fail('invalid-general-query');
  const out: { -readonly [K in keyof Query]: Query[K] } = { type: 'query', queryType: m[1]! };
  const rest = m[2]!;
  if (rest.length > 0) {
    const f = /^ ?(-?[0-9]+(?:\.[0-9]*)?),(-?[0-9]+(?:\.[0-9]*)?),([0-9]{4})$/.exec(rest);
    if (!f) ctx.fail('invalid-general-query');
    out.footprint = { latitude: Number(f[1]), longitude: Number(f[2]), radiusMiles: Number(f[3]) };
  }
  return out;
}

/** `<`: station capabilities. */
export function decodeCapabilities(ctx: DecodeContext, s: string): Capabilities {
  const text = ctx.text(s.slice(1));
  const capabilities: Capability[] = [];
  let freeText = false;
  for (const raw of text.split(',')) {
    const item = raw.trim();
    const eq = item.indexOf('=');
    const token = eq < 0 ? item : item.slice(0, eq);
    if (/\s/.test(token) || token.length === 0) freeText = true;
    capabilities.push(eq < 0 ? [item] : [token, item.slice(eq + 1)]);
  }
  if (freeText) ctx.tolerate('free-text-capabilities');
  return { type: 'capabilities', capabilities };
}

function nmeaDegrees(value: string | undefined, hemisphere: string | undefined, width: number): number | undefined {
  if (value === undefined || hemisphere === undefined) return undefined;
  if (!/^[0-9]+(?:\.[0-9]*)?$/.test(value)) return undefined;
  const dot = value.indexOf('.');
  const intPart = dot < 0 ? value : value.slice(0, dot);
  if (intPart.length < 3) return undefined;
  const degrees = Number(intPart.slice(0, intPart.length - 2));
  const minutes = Number(value.slice(intPart.length - 2));
  if (minutes >= 60) return undefined;
  const v = degrees + minutes / 60;
  if (v > width) return undefined;
  if (hemisphere === 'S' || hemisphere === 'W') return v === 0 ? 0 : -v;
  if (hemisphere === 'N' || hemisphere === 'E') return v;
  return undefined;
}

function nmeaTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^([0-9]{2})([0-9]{2})([0-9]{2})(?:\.([0-9]*))?$/.exec(value);
  if (!m) return undefined;
  let t = `${m[1]}:${m[2]}:${m[3]}`;
  const fraction = (m[4] ?? '').replace(/0+$/, '');
  if (fraction.length > 0) t += `.${fraction}`;
  return t;
}

function nmeaNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/.test(value)) return undefined;
  return Number(value);
}

/** Verifies an NMEA sentence's checksum; `undefined` when it has none. */
export function nmeaChecksumOk(sentence: string): boolean | undefined {
  const m = /\*([0-9A-Fa-f]{2})$/.exec(sentence);
  if (!m) return undefined;
  let x = 0;
  for (let k = 0; k < m.index; k++) x ^= sentence.charCodeAt(k);
  return x === parseInt(m[1]!, 16);
}

/** `$`: raw NMEA, or Ultimeter raw weather (`$ULTW`). */
export function decodeDollar(ctx: DecodeContext, s: string): NmeaSentence | RawWeather {
  if (s.startsWith('$ULTW')) return decodeRawWeather(ctx, s.slice(5), 'ultimeter-packet');
  ctx.info('obsolete-format');
  const sentence = s.slice(1);
  if (!/^[A-Z]{5},[\x20-\x7e]*$/.test(sentence)) ctx.fail('invalid-nmea');
  const checksum = nmeaChecksumOk(sentence);
  if (checksum === false) ctx.fail('nmea-checksum-mismatch');
  if (checksum === undefined && sentence.includes('*')) ctx.fail('invalid-nmea');
  const body = checksum === undefined ? sentence : sentence.slice(0, sentence.length - 3);
  const f = body.split(',');
  const out: { -readonly [K in keyof NmeaSentence]: NmeaSentence[K] } = { type: 'nmea', sentence };
  if (checksum !== undefined) out.hasChecksum = true;
  const set = <K extends keyof NmeaSentence>(key: K, value: NmeaSentence[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  switch (f[0]!.slice(2)) {
    case 'GGA': {
      set('latitude', nmeaDegrees(f[2], f[3], 90));
      set('longitude', nmeaDegrees(f[4], f[5], 180));
      if (f[6] !== undefined && /^[0-9]$/.test(f[6])) out.fix = f[6] === '0' ? 'invalid' : 'valid';
      set('altitudeM', nmeaNumber(f[9]));
      set('time', nmeaTime(f[1]));
      break;
    }
    case 'GLL': {
      set('latitude', nmeaDegrees(f[1], f[2], 90));
      set('longitude', nmeaDegrees(f[3], f[4], 180));
      set('time', nmeaTime(f[5]));
      if (f[6] === 'A') out.fix = 'valid';
      else if (f[6] === 'V') out.fix = 'invalid';
      break;
    }
    case 'RMC': {
      set('time', nmeaTime(f[1]));
      if (f[2] === 'A') out.fix = 'valid';
      else if (f[2] === 'V') out.fix = 'invalid';
      set('latitude', nmeaDegrees(f[3], f[4], 90));
      set('longitude', nmeaDegrees(f[5], f[6], 180));
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
      set('latitude', nmeaDegrees(f[1], f[2], 90));
      set('longitude', nmeaDegrees(f[3], f[4], 180));
      if (f[5] !== undefined && f[5].length > 0) out.waypoint = f[5];
      break;
    }
  }
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
  const m = /^%([0-9]{3})\/([0-9])/.exec(s);
  if (!m) ctx.fail('invalid-agrelo-df');
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
