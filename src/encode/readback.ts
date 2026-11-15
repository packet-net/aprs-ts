// The read-back (vectors README, Rules, Read-back): the one comparison every encoder ends with.
// The bytes written are decoded, leniently, under a well-formed header, and compared with the data
// given: no warning or error, an info only from a short list, and every field of the neutral
// data form equal at every depth in both directions, with exactly three allowances: a number its
// form holds in steps is the value given rounded once to the step of the form written; a value the
// form must carry where the data leaves it out; empty and absent are one value.
//
// This file is the whole comparison. Nothing decides whether it runs, and it does not know which
// field writer produced the bytes: it reads them.

import { binaryToBytes } from '../bytes.js';
import type { RefusalCode } from '../codes.js';
import { KNOTS_TO_MPH, METRES_PER_FOOT } from '../decode/positioned.js';
import { decodeInformation } from '../decode/index.js';
import { formatDiagnostic, ParseOptions, type Diagnostic } from '../diagnostics.js';
import { toNeutralData, type Neutral } from '../neutral.js';
import type { AprsData } from '../types.js';
import { DEFAULT_DESTINATION, nearest } from './common.js';

/** A way the written data would read back differently, with the refusal code it earns. */
export interface Problem {
  readonly code: RefusalCode;
  readonly text: string;
}

function problem(code: RefusalCode, text: string): Problem {
  return { code, text };
}

/** The infos a decode may carry and still match: each attached by the rules to a form the data asks for. */
const ALLOWED_INFOS: ReadonlySet<string> = new Set(['obsolete-format', 'mic-e-missing-device-type', 'invalid-query', 'invalid-telemetry-metadata']);

/** Fields that hold free text; one that reads back changed or lost is text that read as something else. */
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(['comment', 'text', 'data', 'project', 'software', 'unit', 'names', 'units', 'extra', 'status']);

/** The fields an NMEA sentence determines: left out of the data, they are the sentence's own. */
const NMEA_FIELDS: ReadonlySet<string> = new Set(['has_checksum', 'latitude', 'longitude', 'fix', 'course_degrees', 'speed_knots', 'altitude_m', 'time', 'waypoint']);

type N = { [key: string]: unknown };

/** Numbers that agree within 1e-9, relative to the larger (absolute below 1). */
export function sameNumber(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * (scale >= 1 ? scale : 1);
}

// ---- the value a number reads back as: the value given, rounded once to the step of the form written

/** A coordinate as the form written holds it, read from the decode (compressed, ambiguity, `!DAO!`). */
function coordinate(value: number, level: N, latitude: boolean): number {
  if (level.compressed === true) {
    const max = 91 ** 4 - 1;
    const scale = latitude ? 380926 : 190463;
    const steps = Math.min(max, Math.max(0, nearest(scale * (latitude ? 90 - value : 180 + value))));
    return latitude ? 90 - steps / scale : -180 + steps / scale;
  }
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  const ambiguity = typeof level.ambiguity === 'number' ? level.ambiguity : 0;
  if (ambiguity > 0) {
    // The centre of the box that holds the value: cut, never rounded first.
    let centre: number;
    if (ambiguity >= 4) centre = Math.floor(abs + 1e-6) + 0.5;
    else {
      const box = [10, 100, 1000][ambiguity - 1]!;
      centre = (Math.floor((abs * 6000) / box + 1e-6) * box + box / 2) / 6000;
    }
    return negative ? -centre : centre;
  }
  const dao = (level.dao as { precision?: string } | undefined)?.precision;
  // Steps of a minute: hundredths, or a `!DAO!`'s thousandths or ninety-firsts of a hundredth.
  const perMinute = dao === 'thousandths' ? 1000 : dao === 'base91' ? 9100 : 100;
  const degrees = Math.floor(abs + 1e-9);
  const minutes = Math.max(0, (abs - degrees) * 60);
  const rounded = degrees + nearest(minutes * perMinute) / perMinute / 60;
  return negative ? -rounded : rounded;
}

/** A GGA altitude in the cs bytes: 1.002^cs feet, the nearest value they hold (1 foot for 1 foot or less), and whether that is exact. */
function csAltitude(feet: number): { value: number; exact: boolean } {
  const v = feet <= 1 ? 0 : nearest(Math.log(feet) / Math.log(1.002));
  const value = Math.pow(1.002, v);
  return { value, exact: Math.abs(value - feet) <= 1e-9 * Math.abs(feet) };
}

function altitude(feet: number, level: N, levelData: AprsData | undefined): number {
  if (level.type === 'mic-e') {
    // In a /A= whole feet; in the Mic-E bytes whole metres, compared in feet.
    if ((levelData as { altitudeInComment?: boolean } | undefined)?.altitudeInComment) return nearest(feet);
    return nearest(feet * METRES_PER_FOOT) / METRES_PER_FOOT;
  }
  const source = (level.compression as { source?: string } | undefined)?.source;
  if (level.compressed === true && source === 'gga') {
    const cs = csAltitude(feet);
    // A compressed weather report has no comment to hold a /A=: the cs value alone. Otherwise the
    // cs bytes when they hold the value exactly, else the /A= that wins, in whole feet.
    if (level.weather !== undefined) return cs.value;
    return cs.exact ? feet : nearest(feet);
  }
  return nearest(feet);
}

function snowfall(inches: number): number {
  const hundredths = nearest(inches * 100);
  if (hundredths < 100) return hundredths / 100;
  const tenths = nearest(inches * 10);
  if (tenths < 100) return tenths / 10;
  return nearest(inches);
}

function weatherValue(key: string, v: number, level: N): number {
  const compressed = level.compressed === true;
  switch (key) {
    case 'wind_direction_degrees':
      // In the cs bytes: 4-degree steps, and north reads back as 0.
      return compressed ? (nearest(v / 4) % 90) * 4 : nearest(v);
    case 'wind_speed_mph':
      return compressed ? (Math.pow(1.08, nearest(Math.log(v / KNOTS_TO_MPH + 1) / Math.log(1.08))) - 1) * KNOTS_TO_MPH : nearest(v);
    case 'rain_1h_in':
    case 'rain_24h_in':
    case 'rain_midnight_in':
      return nearest(v * 100) / 100;
    case 'pressure_mbar':
      return nearest(v * 10) / 10;
    case 'snow_24h_in':
      return snowfall(v);
    default:
      return nearest(v);
  }
}

/** What a number given reads back as, by the form the decode shows was written. `path` is relative to the level. */
function roundedValue(path: readonly string[], v: number, level: N, levelData: AprsData | undefined): number {
  const type = level.type;
  // Numbers without steps: compared as they are.
  if (type === 'nmea' || type === 'telemetry' || type === 'telemetry-coefficients') return v;
  if (type === 'query') return path[0] === 'footprint' && path[1] !== 'radius_miles' ? v : nearest(v);
  const positioned = type === 'position' || type === 'object' || type === 'item' || type === 'mic-e';
  if (positioned && path.length === 1) {
    switch (path[0]) {
      case 'latitude':
        return coordinate(v, level, true);
      case 'longitude':
        return coordinate(v, level, false);
      case 'course_degrees':
        // In the cs bytes: 4-degree steps, and north reads back as 360.
        return level.compressed === true ? ((nearest(v / 4) % 90) * 4 || 360) : nearest(v);
      case 'speed_knots':
        return level.compressed === true ? Math.pow(1.08, nearest(Math.log(v + 1) / Math.log(1.08))) - 1 : nearest(v);
      case 'altitude_feet':
        return altitude(v, level, levelData);
      case 'range_miles':
        return level.compressed === true ? 2 * Math.pow(1.08, nearest(Math.log(v / 2) / Math.log(1.08))) : nearest(v);
      default:
        return nearest(v);
    }
  }
  if ((positioned || type === 'weather') && path[0] === 'weather' && path.length === 2) return weatherValue(path[1]!, v, level);
  if (positioned && path[0] === 'frequency' && path[1] === 'mhz') {
    const resolution = (level.frequency as { ten_khz_resolution?: boolean } | undefined)?.ten_khz_resolution ? 100 : 1000;
    return nearest(v * resolution) / resolution;
  }
  return nearest(v);
}

// ---- the comparison

interface Level {
  /** The decode, in the neutral form, of the data this level holds. */
  readonly got: N;
  /** The decoded data itself, for what the neutral form does not carry. */
  readonly data: AprsData | undefined;
  /** How this level is named in a problem: empty at the top, `packet.data.` inside a third-party packet. */
  readonly prefix: string;
}

function isObject(v: unknown): v is N {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Compares `want` with `got` at `path`, which is relative to the level they are in. */
function walk(want: unknown, got: unknown, path: string[], level: Level, out: Problem[]): void {
  const name = (extra?: string): string => level.prefix + [...path, ...(extra === undefined ? [] : [extra])].join('.') || 'the data';
  if (typeof want === 'number' && typeof got === 'number') {
    const expected = roundedValue(path, want, level.got, level.data);
    if (!sameNumber(expected, got)) {
      out.push(problem(level.got.type === 'nmea' ? 'invalid-nmea' : 'does-not-read-back', `${name()} would read back as ${got}, not ${expected}`));
    }
    return;
  }
  if (Array.isArray(want) && Array.isArray(got)) {
    if (want.length !== got.length) out.push(problem('text-reads-as-field', `${name()} would have ${got.length} items, not ${want.length}`));
    else want.forEach((x, i) => walk(x, got[i], [...path, String(i)], level, out));
    return;
  }
  if (isObject(want) && isObject(got)) {
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (!(k in want)) {
        if (valueTheFormMustCarry(k, want, got, path, level)) continue;
        out.push(problem('text-reads-as-field', `${name(k)} would appear`));
      } else if (!(k in got)) {
        out.push(problem(FREE_TEXT_FIELDS.has(k) ? 'text-reads-as-field' : 'does-not-read-back', `${name(k)} would be lost`));
      } else if (k === 'data' && path.length === 1 && path[0] === 'packet' && isObject(want[k]) && isObject(got[k])) {
        // A third-party packet's inner data is a level of its own, with its own form to read.
        const inner = (level.data as { packet?: { data?: AprsData } } | undefined)?.packet?.data;
        walk(want[k], got[k], [], { got: got[k] as N, data: inner, prefix: `${level.prefix}packet.data.` }, out);
      } else {
        walk(want[k], got[k], [...path, k], level, out);
      }
    }
    return;
  }
  if (want !== got) out.push(problem('text-reads-as-field', `${name()} would read back as ${JSON.stringify(got)}, not ${JSON.stringify(want)}`));
}

/** Allowance (2): a value the form must carry where the data leaves it out. Only at the top of a level. */
function valueTheFormMustCarry(key: string, want: N, got: N, path: string[], level: Level): boolean {
  if (path.length !== 0) return false;
  switch (level.got.type) {
    case 'nmea':
      return NMEA_FIELDS.has(key);
    case 'mic-e':
      return key === 'speed_knots' && got[key] === 0;
    default: {
      // The default compression type (current fix, other source, software), exactly, on a report whose cs bytes carry a value.
      const c = got[key];
      return key === 'compression' && want.compressed === true && isObject(c) && c.fix === 'current' && c.source === 'other' && c.origin === 'software';
    }
  }
}

/** Where the written data would read back differently from the data given. */
export function compareData(want: Neutral, got: Neutral, data: AprsData | undefined): Problem[] {
  const out: Problem[] = [];
  walk(want, got, [], { got, data, prefix: '' }, out);
  return out;
}

/**
 * A third-party packet's neutral data without its inner packets' `info` diagnostics, which are not
 * compared, given or decoded. A warning or an error in an inner packet is a field like any other: the
 * data given has it or the read-back does not match (a decoded packet re-encoded keeps its own).
 */
function withoutInnerInfo(n: Neutral): Neutral {
  const packet = n.packet as Neutral | undefined;
  if (n.type !== 'third-party' || !isObject(packet)) return n;
  const copy: Neutral = { ...packet };
  if (Array.isArray(copy.diagnostics)) {
    // Warnings and errors are data, compared as a multiset: their order carries nothing.
    const kept = (copy.diagnostics as string[]).filter((d) => !d.startsWith('info:')).sort();
    if (kept.length > 0) copy.diagnostics = kept;
    else delete copy.diagnostics;
  }
  if (isObject(copy.data)) copy.data = withoutInnerInfo(copy.data as Neutral);
  return { ...n, packet: copy };
}

function diagnosticProblems(diagnostics: readonly Diagnostic[]): Problem[] {
  return diagnostics
    .filter((d) => d.severity !== 'info' || !ALLOWED_INFOS.has(d.code))
    .map((d) => problem('text-reads-as-field', `it would read back with ${formatDiagnostic(d)}`));
}

/**
 * The read-back: decodes the information field written (under a well-formed header, for Mic-E
 * the destination computed) and compares it with the data given. An empty list is a match.
 */
export function readBack(data: AprsData, binary: string, destination: string | undefined): Problem[] {
  const decoded = decodeInformation(binaryToBytes(binary), destination ?? DEFAULT_DESTINATION, ParseOptions.lenient);
  const problems = diagnosticProblems(decoded.diagnostics);
  if (decoded.data.type !== data.type) {
    problems.push(problem('text-reads-as-field', `it would read back as ${decoded.data.type}`));
    return problems;
  }
  const got = withoutInnerInfo(toNeutralData(decoded.data));
  const want = withoutInnerInfo(toNeutralData(data));
  const found = compareData(want, got, decoded.data);
  // Whatever differs in a sentence read back is a field that disagrees with it.
  problems.push(...(data.type === 'nmea' ? found.map((p) => problem('invalid-nmea', p.text)) : found));
  return problems;
}
