// Positions, and everything that can follow one: data extensions, weather data, and the
// structured elements lifted out of a comment (APRS12c ch. 6-9, 12, 13, 18).

import type {
  AprsSymbol,
  AprsTimestamp,
  AreaColor,
  AreaObject,
  AreaShape,
  CommentTelemetry,
  CompressionOrigin,
  CompressionSource,
  CompressionType,
  Dao,
  DfBearing,
  Dfs,
  ExtraWeatherField,
  Phg,
  Storm,
  StormType,
  ToneType,
  VoiceFrequency,
  Weather,
} from '../types.js';
import type { DecodeContext } from './context.js';

// ---- small helpers

export function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

export function isBase91(c: string | undefined): boolean {
  if (c === undefined || c.length === 0) return false;
  const code = c.charCodeAt(0);
  return code >= 33 && code <= 123;
}

export function base91Value(s: string): number {
  let v = 0;
  for (let i = 0; i < s.length; i++) v = v * 91 + (s.charCodeAt(i) - 33);
  return v;
}

function isPrintableSymbolCode(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e;
}

/** Whether `c` can be an uncompressed symbol table identifier: `/`, `\`, `0`-`9`, `A`-`Z`. */
export function isSymbolTable(c: string | undefined): boolean {
  return c === '/' || c === '\\' || isDigit(c) || (c !== undefined && c >= 'A' && c <= 'Z');
}

function isCompressedTable(c: string | undefined): boolean {
  return c === '/' || c === '\\' || (c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'j')));
}

export const KNOTS_TO_MPH = 1.150779448;
export const METRES_PER_FOOT = 0.3048;

// ---- timestamps

/** A 7-byte timestamp shaped `ddhhmmz`, `ddhhmm/` or `hhmmssh` at `i`, without checking ranges. */
export function timestampAt(s: string, i: number): AprsTimestamp | undefined {
  if (s.length < i + 7) return undefined;
  for (let k = 0; k < 6; k++) if (!isDigit(s[i + k])) return undefined;
  const a = Number(s.substr(i, 2));
  const b = Number(s.substr(i + 2, 2));
  const c = Number(s.substr(i + 4, 2));
  switch (s[i + 6]) {
    case 'z':
      return { kind: 'dhm-zulu', day: a, hour: b, minute: c };
    case '/':
      return { kind: 'dhm-local', day: a, hour: b, minute: c };
    case 'h':
      return { kind: 'hms', hour: a, minute: b, second: c };
    default:
      return undefined;
  }
}

/** Whether a timestamp's fields are in range. */
export function timestampValid(t: AprsTimestamp): boolean {
  switch (t.kind) {
    case 'dhm-zulu':
    case 'dhm-local':
      return t.day >= 1 && t.day <= 31 && t.hour <= 23 && t.minute <= 59;
    case 'hms':
      return t.hour <= 23 && t.minute <= 59 && t.second <= 59;
    case 'mdhm':
      return t.month >= 1 && t.month <= 12 && t.day >= 1 && t.day <= 31 && t.hour <= 23 && t.minute <= 59;
  }
}

// ---- positions

/** A decoded position, before any `!DAO!` is applied. */
export interface RawPosition {
  latDegrees: number;
  latMinutes: number;
  latSouth: boolean;
  lonDegrees: number;
  lonMinutes: number;
  lonWest: boolean;
  /** For a compressed position, the decoded degrees. */
  latitude: number;
  longitude: number;
  ambiguity: number;
  symbol: AprsSymbol;
  compressed: boolean;
  /** Compressed: the cs bytes were blank (a space). */
  csBlank: boolean;
  compression?: CompressionType;
  /** Compressed cs: course/speed. */
  csCourse?: number;
  csCourseRaw?: number;
  csSpeedKnots?: number;
  csRangeMiles?: number;
  csAltitudeFeet?: number;
  /** Bytes consumed. */
  length: number;
}

function ambiguityDigits(chars: string[]): number | undefined {
  // chars are the four blankable digits, most significant first; blanks must trail.
  let blanks = 0;
  for (let k = chars.length - 1; k >= 0; k--) {
    if (chars[k] === ' ') blanks++;
    else break;
  }
  for (let k = 0; k < chars.length - blanks; k++) if (!isDigit(chars[k])) return undefined;
  return blanks;
}

function ambiguousMinutes(tens: string, units: string, tenths: string, hundredths: string, ambiguity: number): number {
  const d = (c: string): number => (isDigit(c) ? c.charCodeAt(0) - 48 : 0);
  switch (ambiguity) {
    case 0:
      return d(tens) * 10 + d(units) + d(tenths) / 10 + d(hundredths) / 100;
    case 1:
      return d(tens) * 10 + d(units) + d(tenths) / 10 + 0.05;
    case 2:
      return d(tens) * 10 + d(units) + 0.5;
    case 3:
      return d(tens) * 10 + 5;
    default:
      return 30;
  }
}

/** Parses an uncompressed position (`ddmm.hhN/dddmm.hhW$`) at `i`; 19 bytes. */
export function parseUncompressed(ctx: DecodeContext, s: string, i: number): RawPosition {
  if (s.length < i + 19) ctx.fail('truncated');
  // Latitude
  const lat = s.substr(i, 8);
  if (!isDigit(lat[0]) || !isDigit(lat[1]) || lat[4] !== '.') ctx.fail('invalid-latitude');
  const latAmbiguity = ambiguityDigits([lat[2]!, lat[3]!, lat[5]!, lat[6]!]);
  if (latAmbiguity === undefined) ctx.fail('invalid-latitude');
  const latDegrees = Number(lat.substr(0, 2));
  const latMinutes = ambiguousMinutes(lat[2]!, lat[3]!, lat[5]!, lat[6]!, latAmbiguity);
  const rawLatMinutes = ambiguousMinutes(lat[2]!, lat[3]!, lat[5]!, lat[6]!, 0);
  if (rawLatMinutes >= 60 || latDegrees > 90 || (latDegrees === 90 && rawLatMinutes > 0)) ctx.fail('invalid-latitude');
  let ns = lat[7]!;
  if (ns === 'n' || ns === 's') {
    ctx.tolerate('lowercase-hemisphere');
    ns = ns.toUpperCase();
  }
  if (ns !== 'N' && ns !== 'S') ctx.fail('invalid-latitude');
  // Symbol table
  const table = s[i + 8]!;
  if (!isSymbolTable(table)) ctx.fail('invalid-symbol-table');
  // Longitude
  const lon = s.substr(i + 9, 9);
  if (!isDigit(lon[0]) || !isDigit(lon[1]) || !isDigit(lon[2]) || lon[5] !== '.') ctx.fail('invalid-longitude');
  const lonBlanks = ambiguityDigits([lon[3]!, lon[4]!, lon[6]!, lon[7]!]);
  if (lonBlanks === undefined || lonBlanks > latAmbiguity) ctx.fail('invalid-longitude');
  const lonDegrees = Number(lon.substr(0, 3));
  const lonMinutes = ambiguousMinutes(lon[3]!, lon[4]!, lon[6]!, lon[7]!, latAmbiguity);
  const rawLonMinutes = ambiguousMinutes(lon[3]!, lon[4]!, lon[6]!, lon[7]!, 0);
  if (rawLonMinutes >= 60 || lonDegrees > 180 || (lonDegrees === 180 && rawLonMinutes > 0)) ctx.fail('invalid-longitude');
  let ew = lon[8]!;
  if (ew === 'e' || ew === 'w') {
    ctx.tolerate('lowercase-hemisphere');
    ew = ew.toUpperCase();
  }
  if (ew !== 'E' && ew !== 'W') ctx.fail('invalid-longitude');
  const code = s[i + 18]!;
  if (!isPrintableSymbolCode(code)) ctx.fail('invalid-symbol-code');
  const latitude = (ns === 'S' ? -1 : 1) * (latDegrees + latMinutes / 60);
  const longitude = (ew === 'W' ? -1 : 1) * (lonDegrees + lonMinutes / 60);
  return {
    latDegrees,
    latMinutes,
    latSouth: ns === 'S',
    lonDegrees,
    lonMinutes,
    lonWest: ew === 'W',
    latitude: latitude === 0 ? 0 : latitude,
    longitude: longitude === 0 ? 0 : longitude,
    ambiguity: latAmbiguity,
    symbol: { table, code },
    compressed: false,
    csBlank: true,
    length: 19,
  };
}

const COMPRESSION_SOURCES: readonly CompressionSource[] = ['other', 'gll', 'gga', 'rmc'];
const COMPRESSION_ORIGINS: readonly CompressionOrigin[] = [
  'compressed',
  'tnc-beacon-text',
  'software',
  'reserved3',
  'kpc3',
  'pico',
  'other-tracker',
  'digipeater-conversion',
];

/** Decodes a compression type byte's value (0-63). */
export function compressionTypeOf(t: number): CompressionType {
  return {
    fix: (t & 0x20) !== 0 ? 'current' : 'old',
    source: COMPRESSION_SOURCES[(t >> 3) & 3]!,
    origin: COMPRESSION_ORIGINS[t & 7]!,
  };
}

/** Parses a compressed position (`/YYYYXXXX$csT`) at `i`; 13 bytes. */
export function parseCompressed(ctx: DecodeContext, s: string, i: number): RawPosition {
  if (s.length < i + 13) ctx.fail('truncated');
  let table = s[i]!;
  if (table >= 'a' && table <= 'j') table = String.fromCharCode(table.charCodeAt(0) - 49); // a-j -> 0-9
  for (let k = 1; k <= 8; k++) if (!isBase91(s[i + k])) ctx.fail('invalid-compressed-position');
  const latitude = 90 - base91Value(s.substr(i + 1, 4)) / 380926;
  const longitude = -180 + base91Value(s.substr(i + 5, 4)) / 190463;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) ctx.fail('invalid-compressed-position');
  const code = s[i + 9]!;
  if (!isPrintableSymbolCode(code)) ctx.fail('invalid-symbol-code');
  const c = s[i + 10]!;
  const sByte = s[i + 11]!;
  const tByte = s[i + 12]!;
  const pos: RawPosition = {
    latDegrees: 0,
    latMinutes: 0,
    latSouth: false,
    lonDegrees: 0,
    lonMinutes: 0,
    lonWest: false,
    latitude,
    longitude,
    ambiguity: 0,
    symbol: { table, code },
    compressed: true,
    csBlank: c === ' ',
    length: 13,
  };
  if (c === ' ') return pos;
  if (!isBase91(c) || !isBase91(sByte) || !isBase91(tByte)) ctx.fail('invalid-compressed-position');
  let t = tByte.charCodeAt(0) - 33;
  if ((t & 0xc0) !== 0) {
    ctx.tolerate('compression-type-reserved-bits');
    t &= 0x3f;
  }
  pos.compression = compressionTypeOf(t);
  const cv = c.charCodeAt(0) - 33;
  const sv = sByte.charCodeAt(0) - 33;
  if (pos.compression.source === 'gga') {
    pos.csAltitudeFeet = Math.pow(1.002, cv * 91 + sv);
  } else if (cv <= 89) {
    pos.csCourseRaw = cv * 4;
    pos.csCourse = cv === 0 ? 360 : cv * 4;
    pos.csSpeedKnots = Math.pow(1.08, sv) - 1;
  } else {
    pos.csRangeMiles = 2 * Math.pow(1.08, sv);
  }
  return pos;
}

/** Parses a position at `i`, uncompressed or compressed by its first byte. */
export function parsePosition(ctx: DecodeContext, s: string, i: number): RawPosition {
  const c = s[i];
  if (isDigit(c)) return parseUncompressed(ctx, s, i);
  if (isCompressedTable(c)) return parseCompressed(ctx, s, i);
  return ctx.fail('invalid-position');
}

/** Whether a position decodes at `i`, without reporting anything. */
export function positionDecodesAt(ctx: DecodeContext, s: string, i: number): boolean {
  const probe = Object.create(ctx) as DecodeContext;
  // A throwaway context: diagnostics go nowhere and every defect is tolerated silently.
  Object.defineProperty(probe, 'diagnostics', { value: [] });
  try {
    parsePosition(probe, s, i);
    return true;
  } catch {
    return false;
  }
}

// ---- !DAO!

interface DaoFound {
  start: number;
  dao: Dao;
  latAdd: number;
  lonAdd: number;
}

function daoAt(s: string, p: number): DaoFound | undefined {
  if (s[p] !== '!' || s[p + 4] !== '!') return undefined;
  const d = s[p + 1]!;
  const a = s[p + 2]!;
  const o = s[p + 3]!;
  if (d >= 'A' && d <= 'Z') {
    if (a === ' ' && o === ' ') return { start: p, dao: { datum: d, precision: 'none' }, latAdd: 0, lonAdd: 0 };
    if (isDigit(a) && isDigit(o))
      return {
        start: p,
        dao: { datum: d, precision: 'thousandths' },
        latAdd: (a.charCodeAt(0) - 48) / 1000,
        lonAdd: (o.charCodeAt(0) - 48) / 1000,
      };
    return undefined;
  }
  if (d >= 'a' && d <= 'z') {
    const datum = d.toUpperCase();
    if (a === ' ' && o === ' ') return { start: p, dao: { datum, precision: 'none' }, latAdd: 0, lonAdd: 0 };
    if (isBase91(a) && isBase91(o))
      return {
        start: p,
        dao: { datum, precision: 'base91' },
        latAdd: (a.charCodeAt(0) - 33) / 91 / 100,
        lonAdd: (o.charCodeAt(0) - 33) / 91 / 100,
      };
    return undefined;
  }
  return undefined;
}

// ---- base-91 comment telemetry

interface TelemetryFound {
  start: number;
  end: number; // exclusive
  telemetry: CommentTelemetry;
}

function findCommentTelemetry(s: string): TelemetryFound | undefined {
  const last = s.lastIndexOf('|');
  if (last <= 0) return undefined;
  const prev = s.lastIndexOf('|', last - 1);
  if (prev < 0) return undefined;
  const body = s.slice(prev + 1, last);
  if (body.length < 4 || body.length > 14 || body.length % 2 !== 0) return undefined;
  for (let k = 0; k < body.length; k++) if (!isBase91(body[k])) return undefined;
  const values: number[] = [];
  for (let k = 0; k < body.length; k += 2) values.push(base91Value(body.substr(k, 2)));
  const sequence = values[0]!;
  const rest = values.slice(1);
  const telemetry: CommentTelemetry =
    rest.length === 6 ? { sequence, analog: rest.slice(0, 5), digital: rest[5]! } : { sequence, analog: rest };
  return { start: prev, end: last + 1, telemetry };
}

// ---- data extensions

const AREA_SHAPES: readonly AreaShape[] = [
  'open-circle',
  'line-down-right',
  'open-ellipse',
  'open-triangle',
  'open-box',
  'filled-circle',
  'line-down-left',
  'filled-ellipse',
  'filled-triangle',
  'filled-box',
];
const AREA_COLORS: readonly AreaColor[] = [
  'black',
  'blue',
  'green',
  'cyan',
  'red',
  'violet',
  'yellow',
  'gray',
  'black-low',
  'blue-low',
  'green-low',
  'cyan-low',
  'red-low',
  'violet-low',
  'yellow-low',
  'gray-low',
];

export { AREA_SHAPES, AREA_COLORS };

const PHG_RE = /^PHG([0-9])([0-~])([0-9])([0-9])(?:([1-9A-Z])\/)?/;
const RNG_RE = /^RNG([0-9]{4})/;
const DFS_RE = /^DFS([0-9])([0-~])([0-9])([0-9])/;
const CSE_SPD_RE = /^([0-9]{3}|\.{3}| {3})\/([0-9]{3}|\.{3}| {3})/;

function rateValue(c: string): number {
  return isDigit(c) ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
}

interface ExtensionFound {
  length: number;
  phg?: Phg;
  rangeMiles?: number;
  dfs?: Dfs;
}

function extensionAt(s: string, i: number): ExtensionFound | undefined {
  const t = s.slice(i, i + 9);
  let m = PHG_RE.exec(t);
  if (m) {
    const phg: Phg = {
      power: Number(m[1]),
      height: m[2]!.charCodeAt(0) - 48,
      gain: Number(m[3]),
      directivity: Number(m[4]),
      ...(m[5] !== undefined ? { beaconsPerHour: rateValue(m[5]) } : {}),
    };
    return { length: m[0].length, phg };
  }
  m = RNG_RE.exec(t);
  if (m) return { length: 7, rangeMiles: Number(m[1]) };
  m = DFS_RE.exec(t);
  if (m)
    return {
      length: 7,
      dfs: { strength: Number(m[1]), height: m[2]!.charCodeAt(0) - 48, gain: Number(m[3]), directivity: Number(m[4]) },
    };
  return undefined;
}

function findLaterExtension(s: string): { start: number; ext: ExtensionFound } | undefined {
  for (const key of ['PHG', 'RNG', 'DFS']) {
    let from = 0;
    for (;;) {
      const p = s.indexOf(key, from);
      if (p < 0) break;
      const ext = extensionAt(s, p);
      if (ext) return { start: p, ext };
      from = p + 1;
    }
  }
  return undefined;
}

function threeDigits(v: string): number | undefined {
  return /^[0-9]{3}$/.test(v) ? Number(v) : undefined;
}

// ---- voice frequency (APRS12c ch. 18)

const MICROWAVE_BASE: Record<string, number> = {
  A: 1200,
  B: 2300,
  C: 2400,
  D: 3400,
  E: 5600,
  F: 5700,
  G: 5800,
  H: 10100,
  I: 10200,
  J: 10300,
  K: 10400,
  L: 10500,
  M: 24000,
  N: 24100,
  O: 24200,
};

export { MICROWAVE_BASE };

const FREQ_KHZ_RE = /^([0-9]{3}|[A-O][0-9]{2})\.([0-9]{3})MHz/i;
const FREQ_10KHZ_RE = /^([0-9]{3}|[A-O][0-9]{2})\.([0-9]{2}) MHz/i;

function frequencyMhz(whole: string, fraction: string): number {
  const first = whole[0]!;
  const base = isDigit(first) ? Number(whole) : MICROWAVE_BASE[first]! + Number(whole.slice(1));
  return base + Number(fraction) / Math.pow(10, fraction.length);
}

interface FrequencyFound {
  frequency: VoiceFrequency;
  length: number;
}

/** Parses a voice frequency and its tone, offset and range fields at the start of `s`. */
function frequencyAt(s: string): FrequencyFound | undefined {
  let m = FREQ_KHZ_RE.exec(s);
  let tenKhz = false;
  if (!m) {
    m = FREQ_10KHZ_RE.exec(s);
    tenKhz = true;
  }
  if (!m) return undefined;
  let freq: { -readonly [K in keyof VoiceFrequency]: VoiceFrequency[K] } = { mhz: frequencyMhz(m[1]!, m[2]!) };
  if (tenKhz) freq.tenKhzResolution = true;
  let p = m[0].length;
  const fieldAt = (re: RegExp): RegExpExecArray | undefined => {
    if (s[p] !== ' ') return undefined;
    const r = re.exec(s.slice(p + 1));
    if (!r) return undefined;
    const after = s[p + 1 + r[0].length];
    if (after !== undefined && after !== ' ') return undefined;
    return r;
  };
  let r = fieldAt(/^(?:([TtCcDd])([0-9]{3})|([Tt])off|(1|l)750)/);
  if (r) {
    if (r[1] !== undefined) {
      const kind: ToneType = r[1].toLowerCase() === 't' ? 'tone' : r[1].toLowerCase() === 'c' ? 'ctcss' : 'dcs';
      freq = { ...freq, tone: kind, toneValue: Number(r[2]) };
      if (r[1] >= 'a') freq.narrow = true;
    } else if (r[3] !== undefined) {
      freq = { ...freq, tone: 'off' };
      if (r[3] === 't') freq.narrow = true;
    } else {
      freq = { ...freq, tone: 'tone-burst' };
      if (r[4] === 'l') freq.narrow = true;
    }
    p += 1 + r[0].length;
  }
  r = fieldAt(/^([+-])([0-9]{3})/);
  if (r) {
    freq.offsetKhz = (r[1] === '-' ? -1 : 1) * Number(r[2]) * 10;
    p += 1 + r[0].length;
  }
  r = fieldAt(/^R([0-9]{2,3})([mk])/);
  if (r) {
    freq.range = Number(r[1]);
    if (r[2] === 'k') freq.rangeKm = true;
    p += 1 + r[0].length;
  }
  // One space after the frequency and its fields is a separator.
  if (s[p] === ' ') p++;
  return { frequency: sortFrequency(freq), length: p };
}

function sortFrequency(f: VoiceFrequency): VoiceFrequency {
  const out: { -readonly [K in keyof VoiceFrequency]: VoiceFrequency[K] } = { mhz: f.mhz };
  if (f.tone !== undefined) out.tone = f.tone;
  if (f.toneValue !== undefined) out.toneValue = f.toneValue;
  if (f.offsetKhz !== undefined) out.offsetKhz = f.offsetKhz;
  if (f.range !== undefined) out.range = f.range;
  if (f.rangeKm) out.rangeKm = true;
  if (f.narrow) out.narrow = true;
  if (f.tenKhzResolution) out.tenKhzResolution = true;
  return out;
}

// ---- the positioned fields shared by positions, objects, items and Mic-E

/** Mutable positioned fields, as they are built up. */
export interface Fields {
  latitude: number;
  longitude: number;
  ambiguity?: number;
  symbol: AprsSymbol;
  compressed?: boolean;
  compression?: CompressionType;
  courseDegrees?: number;
  speedKnots?: number;
  altitudeFeet?: number;
  phg?: Phg;
  rangeMiles?: number;
  dfs?: Dfs;
  area?: AreaObject;
  dfBearing?: DfBearing;
  storm?: Storm;
  dao?: Dao;
  telemetry?: CommentTelemetry;
  frequency?: VoiceFrequency;
  weather?: Weather;
  signpost?: string;
  comment?: string;
}

/** Options for lifting elements out of a comment. */
interface LiftOptions {
  /** A data extension came straight after the symbol, so none is looked for later. */
  extensionFound: boolean;
  /** Look for a data extension at the very start of the text first (Mic-E status text). */
  extensionAtStart?: boolean;
  symbol: AprsSymbol;
  /** An area object's line shape, whose corridor width may be in braces. */
  areaLine?: boolean;
}

/** What the comment lifting found. */
interface Lifted {
  telemetry?: CommentTelemetry;
  dao?: DaoFound;
  altitudeFeet?: number;
  signpost?: string;
  corridorWidthMiles?: number;
  phg?: Phg;
  rangeMiles?: number;
  dfs?: Dfs;
  frequency?: VoiceFrequency;
  /** The comment text left (binary). */
  rest: string;
}

function removeRanges(s: string, ranges: readonly [number, number][]): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let from = 0;
  for (const [a, b] of sorted) {
    out += s.slice(from, a);
    from = b;
  }
  return out + s.slice(from);
}

/** Lifts base-91 telemetry and the last `!DAO!` outside it. */
function liftTelemetryAndDao(s: string): { telemetry?: CommentTelemetry; dao?: DaoFound; rest: string } {
  const tel = findCommentTelemetry(s);
  let dao: DaoFound | undefined;
  for (let p = s.length - 5; p >= 0; p--) {
    if (tel && p + 5 > tel.start && p < tel.end) continue;
    const found = daoAt(s, p);
    if (found) {
      dao = found;
      break;
    }
  }
  const ranges: [number, number][] = [];
  if (tel) ranges.push([tel.start, tel.end]);
  if (dao) ranges.push([dao.start, dao.start + 5]);
  const out: { telemetry?: CommentTelemetry; dao?: DaoFound; rest: string } = { rest: removeRanges(s, ranges) };
  if (tel) out.telemetry = tel.telemetry;
  if (dao) out.dao = dao;
  return out;
}

const ALTITUDE_RE = /\/A=(-[0-9]{5}|[0-9]{6})/;

/** Lifts the structured elements out of a comment, in the order the vectors' README gives. */
function liftComment(ctx: DecodeContext, text: string, options: LiftOptions): Lifted {
  const first = liftTelemetryAndDao(text);
  const lifted: Lifted = { rest: first.rest };
  if (first.telemetry) lifted.telemetry = first.telemetry;
  if (first.dao) lifted.dao = first.dao;
  let s = first.rest;
  let extensionFound = options.extensionFound;
  if (options.extensionAtStart) {
    const ext = extensionAt(s, 0);
    if (ext) {
      applyExtension(lifted, ext);
      s = s.slice(ext.length);
      extensionFound = true;
    }
  }
  // Altitude anywhere.
  const alt = ALTITUDE_RE.exec(s);
  if (alt) {
    lifted.altitudeFeet = Number(alt[1]);
    s = s.slice(0, alt.index) + s.slice(alt.index + alt[0].length);
  }
  // Signpost or corridor braces.
  if (isSignpost(options.symbol) || options.areaLine) {
    const brace = /\{([^{}]{1,3})\}/.exec(s);
    if (brace) {
      if (isSignpost(options.symbol)) {
        lifted.signpost = brace[1]!;
        s = s.slice(0, brace.index) + s.slice(brace.index + brace[0].length);
      } else if (/^[0-9]{1,3}$/.test(brace[1]!)) {
        lifted.corridorWidthMiles = Number(brace[1]);
        s = s.slice(0, brace.index) + s.slice(brace.index + brace[0].length);
      }
    }
  }
  // A data extension later in the text, only when none came straight after the symbol.
  if (!extensionFound) {
    const later = findLaterExtension(s);
    if (later && ctx.allows('data-extension-in-comment')) {
      applyExtension(lifted, later.ext);
      s = s.slice(0, later.start) + s.slice(later.start + later.ext.length);
    }
  }
  // A voice frequency at the start, after at most one space or /.
  let freq = frequencyAt(s);
  let skip = 0;
  if (!freq && (s[0] === ' ' || s[0] === '/')) {
    freq = frequencyAt(s.slice(1));
    skip = 1;
  }
  if (freq) {
    lifted.frequency = freq.frequency;
    s = s.slice(skip + freq.length);
  }
  // One leading delimiter.
  if (s[0] === ' ' || s[0] === '/') s = s.slice(1);
  lifted.rest = s;
  return lifted;
}

function applyExtension(lifted: Lifted, ext: ExtensionFound): void {
  if (ext.phg) lifted.phg = ext.phg;
  if (ext.rangeMiles !== undefined) lifted.rangeMiles = ext.rangeMiles;
  if (ext.dfs) lifted.dfs = ext.dfs;
}

function isSignpost(symbol: AprsSymbol): boolean {
  return symbol.table === '\\' && symbol.code === 'm';
}

// ---- weather data (APRS12c ch. 12)

const WEATHER_WIDTH: Record<string, number> = {
  c: 3,
  s: 3,
  g: 3,
  t: 3,
  r: 3,
  p: 3,
  P: 3,
  h: 2,
  b: 5,
  L: 3,
  l: 3,
  '#': 3,
};

type MutableWeather = { -readonly [K in keyof Weather]: Weather[K] };

/** The wind a weather report starts with, from an extension or the compressed cs bytes. */
export interface WindStart {
  /** Some wind source was present (even if unknown). */
  present: boolean;
  direction?: number;
  speedMph?: number;
}

export interface WeatherParse {
  weather: MutableWeather;
  /** The index after the fields. */
  end: number;
  /** Wind came from c/s fields. */
  windFromFields: boolean;
}

interface WeatherFieldOptions {
  wind: WindStart;
  /** Positionless (`_`) report: c and s are its wind fields. */
  positionless: boolean;
  /** After a compressed position, whose cs bytes are where the wind goes. */
  compressed?: boolean;
}

/**
 * A weather field's value: a run of dots (unknown) at most `width` long, exactly `width` spaces
 * (unknown), or digits.
 */
function weatherValueRun(s: string, j: number, width: number, signed: boolean): string {
  if (s[j] === ' ') return s.slice(j, j + width) === ' '.repeat(width) ? s.slice(j, j + width) : '';
  if (s[j] === '.') {
    let k = j;
    while (s[k] === '.' && k - j < width) k++;
    return s.slice(j, k);
  }
  let k = j;
  if (signed && s[k] === '-') k++;
  const digitsFrom = k;
  while (isDigit(s[k])) k++;
  if (k === digitsFrom) return '';
  return s.slice(j, k);
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}

/** Parses the run of weather fields from `j`. */
function parseWeatherFields(ctx: DecodeContext, s: string, j: number, options: WeatherFieldOptions): WeatherParse {
  const w: MutableWeather = {};
  if (options.wind.direction !== undefined) w.windDirectionDegrees = options.wind.direction;
  if (options.wind.speedMph !== undefined) w.windSpeedMph = options.wind.speedMph;
  const seen = new Set<string>();
  let windKnown = options.wind.present;
  let windFromFields = false;
  let warnedWindFields = false;
  const extra: ExtraWeatherField[] = [];
  for (;;) {
    const letter = s[j];
    if (letter === undefined) break;
    let key = letter;
    const width = WEATHER_WIDTH[letter];
    if (letter === 's') {
      // s is the wind speed after c (or first thing in a positionless report), else snowfall.
      const windSlot = !seen.has('s:wind') && (seen.has('c') || (options.positionless && !windKnown));
      key = windSlot ? 's:wind' : 's:snow';
    }
    if (width !== undefined) {
      if (seen.has(key)) break;
      if (letter === 'c' && windKnown) break;
      if (key === 's:snow') {
        const v = s.slice(j + 1, j + 4);
        const dots = /^\.+/.exec(s.slice(j + 1))?.[0];
        if (dots !== undefined) {
          if (dots.length !== 3) ctx.tolerate('non-standard-weather-field-width');
          seen.add(key);
          j += 1 + dots.length;
          continue;
        }
        if (!/^[0-9.]{3}$/.test(v) || !/[0-9]/.test(v)) break;
        w.snow24hIn = Number(v);
        seen.add(key);
        j += 4;
        continue;
      }
      let run = weatherValueRun(s, j + 1, width, letter === 't');
      if (run.length === 0) break;
      if (run.length > width + 1) run = run.slice(0, width);
      if (run.length !== width) ctx.tolerate('non-standard-weather-field-width');
      seen.add(key);
      j += 1 + run.length;
      const unknown = /^(?:\.+| +)$/.test(run);
      if (letter === 'c' || key === 's:wind') {
        windFromFields = true;
        if (!warnedWindFields && !options.positionless) {
          warnedWindFields = true;
          ctx.tolerate('wind-fields-instead-of-extension');
        }
      }
      if (unknown) continue;
      const v = Number(run);
      switch (key) {
        case 'c':
          if (v > 360) ctx.tolerate('out-of-range-value');
          else w.windDirectionDegrees = v;
          break;
        case 's:wind':
          w.windSpeedMph = v;
          break;
        case 'g':
          w.windGustMph = v;
          break;
        case 't':
          w.temperatureF = v;
          break;
        case 'r':
          w.rain1hIn = v / 100;
          break;
        case 'p':
          w.rain24hIn = v / 100;
          break;
        case 'P':
          w.rainMidnightIn = v / 100;
          break;
        case 'h':
          if (v > 100) ctx.tolerate('out-of-range-value');
          else w.humidityPercent = v === 0 ? 100 : v;
          break;
        case 'b':
          w.pressureMbar = v / 10;
          break;
        case 'L':
          w.luminosityWM2 = v;
          break;
        case 'l':
          w.luminosityWM2 = v + 1000;
          break;
        case '#':
          w.rainRaw = v;
          break;
      }
      continue;
    }
    if (isLetter(letter)) {
      const m = /^[0-9.-]{2,}/.exec(s.slice(j + 1));
      if (m && isDigit(m[0][m[0].length - 1])) {
        extra.push({ letter, value: m[0] });
        j += 1 + m[0].length;
        continue;
      }
    }
    break;
  }
  if (seen.has('c') || seen.has('s:wind')) windKnown = true;
  if (extra.length > 0) w.extra = extra;
  // Completeness: wind, and gust and temperature.
  if (options.positionless) {
    if (!seen.has('c') || !seen.has('s:wind') || !seen.has('g') || !seen.has('t')) ctx.tolerate('incomplete-weather');
  } else {
    // An uncompressed report's wind (the DDD/SSS extension, or c/s fields), then gust and temperature.
    if (!windKnown && !options.compressed) ctx.tolerate('incomplete-weather');
    if (!seen.has('g') || !seen.has('t')) ctx.tolerate('incomplete-weather');
  }
  return { weather: w, end: j, windFromFields };
}

const SOFTWARE_UNIT_RE = /^([A-Za-z])([A-Za-z0-9_-]{2,4})$/;

/** The software type and unit after the weather fields, or the weather comment. */
function weatherTail(
  ctx: DecodeContext,
  w: MutableWeather,
  rest: string,
): { comment?: string; telemetry?: CommentTelemetry; dao?: DaoFound } {
  const lifted = liftTelemetryAndDao(rest);
  const out: { comment?: string; telemetry?: CommentTelemetry; dao?: DaoFound } = {};
  if (lifted.telemetry) out.telemetry = lifted.telemetry;
  if (lifted.dao) out.dao = lifted.dao;
  let text = lifted.rest;
  if (text.length === 0) return out;
  const m = SOFTWARE_UNIT_RE.exec(text);
  if (m && !/^[0-9]+$/.test(m[2]!)) {
    w.software = m[1]!;
    w.unit = m[2]!;
    return out;
  }
  ctx.tolerate('weather-comment');
  if (text[0] === ' ' || text[0] === '/') text = text.slice(1);
  if (text.length > 0) out.comment = text;
  return out;
}

/** Parses a positionless weather report's fields and tail from `j`. */
export function parsePositionlessWeather(
  ctx: DecodeContext,
  s: string,
  j: number,
): { weather: Weather; comment?: string } {
  const parsed = parseWeatherFields(ctx, s, j, { wind: { present: false }, positionless: true });
  const tail = weatherTail(ctx, parsed.weather, s.slice(parsed.end));
  const out: { weather: Weather; comment?: string } = { weather: parsed.weather };
  if (tail.comment !== undefined) out.comment = ctx.text(tail.comment);
  return out;
}

// ---- after the position: extension, weather or comment

/** What follows a position, decoded into the fields. */
export function decodeAfterPosition(ctx: DecodeContext, s: string, i: number, pos: RawPosition): Fields {
  const f: Fields = { latitude: pos.latitude, longitude: pos.longitude, symbol: pos.symbol };
  if (pos.ambiguity > 0) f.ambiguity = pos.ambiguity;
  if (pos.compressed) {
    f.compressed = true;
    if (pos.compression) f.compression = pos.compression;
  }
  let dao: DaoFound | undefined;
  if (pos.symbol.code === '_') {
    dao = decodeWeatherAfterPosition(ctx, s, i, pos, f);
  } else {
    dao = decodeExtensionAndComment(ctx, s, i, pos, f);
  }
  applyDao(ctx, f, pos, dao);
  return f;
}

/** Applies a `!DAO!` to the fields. */
export function applyDao(ctx: DecodeContext, f: Fields, pos: RawPosition, dao: DaoFound | undefined): void {
  if (!dao) return;
  f.dao = dao.dao;
  if (pos.compressed) return;
  if (pos.ambiguity > 0) {
    ctx.tolerate('dao-with-ambiguity');
    return;
  }
  const lat = (pos.latSouth ? -1 : 1) * (pos.latDegrees + (pos.latMinutes + dao.latAdd) / 60);
  const lon = (pos.lonWest ? -1 : 1) * (pos.lonDegrees + (pos.lonMinutes + dao.lonAdd) / 60);
  f.latitude = lat === 0 ? 0 : lat;
  f.longitude = lon === 0 ? 0 : lon;
}

function decodeExtensionAndComment(
  ctx: DecodeContext,
  s: string,
  i: number,
  pos: RawPosition,
  f: Fields,
): DaoFound | undefined {
  let extensionFound = false;
  if (pos.compressed) {
    if (pos.csCourse !== undefined) {
      f.courseDegrees = pos.csCourse;
      f.speedKnots = pos.csSpeedKnots!;
    } else if (pos.csRangeMiles !== undefined) {
      f.rangeMiles = pos.csRangeMiles;
      extensionFound = true;
    } else if (pos.csAltitudeFeet !== undefined) {
      f.altitudeFeet = pos.csAltitudeFeet;
    }
  } else {
    const isArea = pos.symbol.table === '\\' && pos.symbol.code === 'l';
    const t = s.slice(i, i + 7);
    const cs = CSE_SPD_RE.exec(t);
    let area: RegExpExecArray | null = null;
    if (isArea) area = /^([0-9])([0-9]{2})(\/[0-9]|1[0-5])([0-9]{2})/.exec(t);
    if (area) {
      const colorCode = area[3]!.startsWith('/') ? Number(area[3]![1]) : Number(area[3]);
      f.area = {
        shape: AREA_SHAPES[Number(area[1])]!,
        color: AREA_COLORS[colorCode]!,
        latOffset: Number(area[2]),
        lonOffset: Number(area[4]),
      };
      i += 7;
    } else if (cs) {
      const course = threeDigits(cs[1]!);
      const speed = threeDigits(cs[2]!);
      if (course !== undefined) {
        if (course > 360) ctx.tolerate('out-of-range-value');
        else f.courseDegrees = course;
      }
      if (speed !== undefined) f.speedKnots = speed;
      i += 7;
      if (pos.symbol.table === '/' && pos.symbol.code === '\\') {
        const df = /^\/([0-9]{3})\/([0-9])([0-9])([0-9])/.exec(s.slice(i, i + 8));
        if (df) {
          f.dfBearing = {
            bearingDegrees: Number(df[1]),
            number: Number(df[2]),
            range: Number(df[3]),
            quality: Number(df[4]),
          };
          i += 8;
        }
      }
      if (pos.symbol.code === '@' && (pos.symbol.table === '/' || pos.symbol.table === '\\')) {
        const storm = parseStorm(s.slice(i));
        if (storm) {
          f.storm = storm.storm;
          i += storm.length;
        }
      }
    } else {
      const ext = extensionAt(s, i);
      if (ext) {
        if (ext.phg) f.phg = ext.phg;
        if (ext.rangeMiles !== undefined) f.rangeMiles = ext.rangeMiles;
        if (ext.dfs) f.dfs = ext.dfs;
        i += ext.length;
        extensionFound = true;
      }
    }
  }
  const areaLine = f.area !== undefined && (f.area.shape === 'line-down-right' || f.area.shape === 'line-down-left');
  const lifted = liftComment(ctx, s.slice(i), { extensionFound, symbol: pos.symbol, areaLine });
  applyLifted(ctx, f, lifted);
  return lifted.dao;
}

function applyLifted(ctx: DecodeContext, f: Fields, lifted: Lifted): void {
  if (lifted.altitudeFeet !== undefined) f.altitudeFeet = lifted.altitudeFeet;
  if (lifted.phg) f.phg = lifted.phg;
  if (lifted.rangeMiles !== undefined) f.rangeMiles = lifted.rangeMiles;
  if (lifted.dfs) f.dfs = lifted.dfs;
  if (lifted.corridorWidthMiles !== undefined && f.area) f.area = { ...f.area, corridorWidthMiles: lifted.corridorWidthMiles };
  if (lifted.telemetry) f.telemetry = lifted.telemetry;
  if (lifted.frequency) f.frequency = lifted.frequency;
  if (lifted.signpost !== undefined) f.signpost = ctx.text(lifted.signpost);
  if (lifted.rest.length > 0) {
    const text = ctx.text(lifted.rest);
    if (text.length > 0) f.comment = text;
  }
}

const STORM_TYPES: Record<string, StormType> = { TS: 'tropical-storm', HC: 'hurricane', TD: 'tropical-depression' };

function parseStorm(s: string): { storm: Storm; length: number } | undefined {
  const m = /^\/(TS|HC|TD)\/([0-9 .]{3})\^([0-9 .]{3})\/([0-9 .]{4})>([0-9 .]{3})&([0-9 .]{3})(?:%([0-9 .]{3}))?/.exec(s);
  if (!m) return undefined;
  const num = (v: string | undefined): number | undefined => (v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : undefined);
  const storm: { -readonly [K in keyof Storm]: Storm[K] } = { type: STORM_TYPES[m[1]!]! };
  const set = (key: 'sustainedWindKnots' | 'gustKnots' | 'centralPressureMbar' | 'hurricaneRadiusNm' | 'tropicalStormRadiusNm' | 'wholeGaleRadiusNm', v: string | undefined): void => {
    const n = num(v);
    if (n !== undefined) storm[key] = n;
  };
  set('sustainedWindKnots', m[2]);
  set('gustKnots', m[3]);
  set('centralPressureMbar', m[4]);
  set('hurricaneRadiusNm', m[5]);
  set('tropicalStormRadiusNm', m[6]);
  set('wholeGaleRadiusNm', m[7]);
  return { storm, length: m[0].length };
}

const DEFAULT_COMPRESSION: CompressionType = { fix: 'current', source: 'other', origin: 'software' };

function decodeWeatherAfterPosition(
  ctx: DecodeContext,
  s: string,
  i: number,
  pos: RawPosition,
  f: Fields,
): DaoFound | undefined {
  const wind: WindStart = { present: false };
  let windFromCs = false;
  if (pos.compressed && pos.csCourseRaw !== undefined) {
    wind.present = true;
    windFromCs = true;
    wind.direction = pos.csCourseRaw;
    wind.speedMph = pos.csSpeedKnots! * KNOTS_TO_MPH;
  } else if (pos.compressed && pos.csAltitudeFeet !== undefined) {
    f.altitudeFeet = pos.csAltitudeFeet;
  } else if (pos.compressed && pos.csRangeMiles !== undefined) {
    f.rangeMiles = pos.csRangeMiles;
  }
  const ext = CSE_SPD_RE.exec(s.slice(i, i + 7));
  let windFromExtension = false;
  if (ext) {
    if (pos.compressed) ctx.tolerate('wind-extension-after-compressed');
    wind.present = true;
    windFromExtension = true;
    delete wind.direction;
    delete wind.speedMph;
    const dir = threeDigits(ext[1]!);
    const spd = threeDigits(ext[2]!);
    if (dir !== undefined) {
      if (dir > 360) ctx.tolerate('out-of-range-value');
      else wind.direction = dir;
    }
    if (spd !== undefined) wind.speedMph = spd;
    i += 7;
  }
  const parsed = parseWeatherFields(ctx, s, i, { wind, positionless: false, compressed: pos.compressed });
  const tail = weatherTail(ctx, parsed.weather, s.slice(parsed.end));
  f.weather = parsed.weather;
  if (pos.compressed && pos.csBlank && !windFromCs) {
    const hasWind = parsed.weather.windDirectionDegrees !== undefined || parsed.weather.windSpeedMph !== undefined;
    if (hasWind && (windFromExtension || parsed.windFromFields)) f.compression = DEFAULT_COMPRESSION;
  }
  if (tail.telemetry) f.telemetry = tail.telemetry;
  if (tail.comment !== undefined) {
    const text = ctx.text(tail.comment);
    if (text.length > 0) f.comment = text;
  }
  return tail.dao;
}

// ---- Mic-E status text

export interface MicEText {
  fields: Partial<Fields>;
  dao?: DaoFound;
}

/** Lifts the elements out of Mic-E status text after its type code, altitude and locator. */
export function liftMicEComment(ctx: DecodeContext, text: string, symbol: AprsSymbol): { lifted: Lifted } {
  const lifted = liftComment(ctx, text, { extensionFound: false, extensionAtStart: true, symbol });
  return { lifted };
}

/** Applies lifted comment elements to fields (Mic-E). */
export function applyLiftedTo(ctx: DecodeContext, f: Fields, lifted: Lifted): void {
  applyLifted(ctx, f, lifted);
}

export type { DaoFound, Lifted };
