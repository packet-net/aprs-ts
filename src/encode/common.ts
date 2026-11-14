// Shared pieces of the encoder.

import { encodeUtf8Binary } from '../bytes.js';
import type { RefusalCode } from '../codes.js';
import type { AprsSymbol, AprsTimestamp } from '../types.js';

/** The tocall used when none is given: the experimental `APZ` range. */
export const DEFAULT_DESTINATION = 'APZ001';

/** Thrown when the encoder declines to write something the spec does not allow; says why. */
export class AprsEncodeError extends Error {
  /** The reason as a code a program can act on; the message is for people and is not stable. */
  readonly code: RefusalCode;

  /**
   * True for a `too-long` that is for the information field's 256 bytes: it is given only when no
   * other code applies. A field over its own limit (message text over 67, say) is not this.
   */
  readonly informationSize: boolean;

  constructor(message: string, code: RefusalCode = 'does-not-read-back', informationSize = false) {
    super(message);
    this.name = 'AprsEncodeError';
    this.code = code;
    this.informationSize = informationSize;
  }
}

export function refuse(code: RefusalCode, reason: string): never {
  throw new AprsEncodeError(reason, code);
}

/**
 * The order in which several faults in one packet are reported: the first code that applies wins
 * (vectors refusals: DESIGN rulings, R1). The header comes first, a field wrong on its own is
 * wrong whatever else is given, then what the frame cannot hold, then the companions, and the
 * read-back safety nets last.
 */
const REFUSAL_ORDER: readonly RefusalCode[] = [
  'not-encodable',
  'invalid-address', 'ax25-cannot-carry', 'tnc2-cannot-carry', 'invalid-third-party-header',
  'invalid-addressee', 'invalid-name', 'invalid-timestamp', 'not-a-number', 'value-out-of-range',
  'value-has-no-form', 'invalid-code', 'invalid-symbol', 'invalid-character', 'too-long',
  'padding-space', 'malformed', 'invalid-message-id', 'invalid-nmea',
  'extension-conflict', 'field-not-allowed', 'symbol-mismatch', 'missing-field', 'value-given-twice',
  'text-reads-as-field',
  'does-not-read-back',
];

/** Where a code sits in the reporting order; a code outside it comes last. */
export function refusalRank(code: RefusalCode): number {
  const i = REFUSAL_ORDER.indexOf(code);
  return i < 0 ? REFUSAL_ORDER.length : i;
}

/** The refusal that comes first in the reporting order (the earliest among equals). */
export function firstRefusal<T extends { readonly code: RefusalCode }>(all: readonly T[]): T {
  let best = all[0]!;
  for (const e of all) if (refusalRank(e.code) < refusalRank(best.code)) best = e;
  return best;
}

/** The code for a value that fails a range check: not-a-number for NaN or an infinity, else out of range. */
export function numberFault(value: number): RefusalCode {
  return Number.isFinite(value) ? 'value-out-of-range' : 'not-a-number';
}

const givenTwice = new WeakMap<object, string>();

/** Marks data a builder was given a value for in two units; the encoder refuses it with the rest of its faults. */
export function markGivenTwice<T extends object>(data: T, reason: string): T {
  givenTwice.set(data, reason);
  return data;
}

/** Why data was marked as given in two units, if it was. */
export function givenTwiceReason(data: object): string | undefined {
  return givenTwice.get(data);
}

const micEAltitudeBytes = new WeakSet<object>();

/** Marks Mic-E data whose altitude a builder rounded to the metre: it goes in the Mic-E altitude bytes, never a `/A=`. */
export function markMicEAltitudeBytesOnly<T extends object>(data: T): T {
  micEAltitudeBytes.add(data);
  return data;
}

/** Whether Mic-E data was marked to send its altitude in the Mic-E altitude bytes only. */
export function micEAltitudeBytesOnly(data: object): boolean {
  return micEAltitudeBytes.has(data);
}

let faults: AprsEncodeError[] | undefined;

/**
 * Notes a fault and carries on, so that every fault in the data is found and the one that comes
 * first in the reporting order is the one reported. Outside `collect` it refuses at once.
 */
export function flag(code: RefusalCode, reason: string): void {
  const e = new AprsEncodeError(reason, code);
  if (faults === undefined) throw e;
  faults.push(e);
}

/**
 * Runs an encoder step, and refuses with the first-ranked of the faults it flagged or threw. A
 * step that goes wrong on the way past a flagged fault (data it cannot use) is not reported.
 */
export function collect<T>(step: () => T): T {
  const outer = faults;
  const mine: AprsEncodeError[] = [];
  faults = mine;
  let result: T | undefined;
  let other: unknown;
  let failed = false;
  try {
    result = step();
  } catch (e) {
    if (e instanceof AprsEncodeError) mine.push(e);
    else {
      failed = true;
      other = e;
    }
  } finally {
    faults = outer;
  }
  if (mine.length > 0) throw firstRefusal(mine);
  if (failed) throw other;
  return result as T;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * The nearest whole number, halves away from zero, as the vectors' rules round wherever they say
 * "nearest" (`Math.round` takes a half towards +infinity, so -2.5 to -2). A value within 1e-6 of a
 * half is the half: decimal text such as 58.585 is seldom exactly that in binary, and the half the
 * text means wins (vectors rulings, F2).
 */
export function nearest(value: number): number {
  const abs = Math.abs(value);
  const below = Math.floor(abs);
  const n = abs - below >= 0.5 - HALF_TOLERANCE ? below + 1 : below;
  return value < 0 ? -n : n;
}

/** How near a half, in steps, a value is taken for the half. */
const HALF_TOLERANCE = 1e-6;

/** A whole number within [min, max], else refused; a fraction is rounded to the nearest. */
export function whole(
  value: number,
  min: number,
  max: number,
  what: string,
  outside: RefusalCode = 'value-out-of-range',
  noForm?: number,
): number {
  if (!Number.isFinite(value)) flag('not-a-number', `${what} is not a number`);
  const n = nearest(value);
  if (n === noForm) flag('value-has-no-form', `${what} ${value} is out of range (${min}-${max})`);
  else if (n < min || n > max) flag(outside, `${what} ${value} is out of range (${min}-${max})`);
  return n;
}

/**
 * Free text as UTF-8 bytes (a binary string); refuses a control character (a byte below 0x20, a
 * line break included, or 0x7F). Text that is data, test data, is refused only a line break, which
 * receivers strip: `controls` false.
 */
export function freeText(text: string, what: string, controls = true): string {
  if (controls ? /[\x00-\x1f\x7f]/.test(text) : /[\r\n]/.test(text)) flag('invalid-character', `${what} contains a control character`);
  return encodeUtf8Binary(text);
}

export function isValidTimestamp(t: AprsTimestamp): boolean {
  const ok = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  switch (t.kind) {
    case 'dhm-zulu':
    case 'dhm-local':
      return ok(t.day, 1, 31) && ok(t.hour, 0, 23) && ok(t.minute, 0, 59);
    case 'hms':
      return ok(t.hour, 0, 23) && ok(t.minute, 0, 59) && ok(t.second, 0, 59);
    case 'mdhm':
      return ok(t.month, 1, 12) && ok(t.day, 1, 31) && ok(t.hour, 0, 23) && ok(t.minute, 0, 59);
  }
}

/** A 7-byte timestamp for a position or object report. */
export function timestamp7(t: AprsTimestamp): string {
  if (!isValidTimestamp(t)) flag('invalid-timestamp', 'the timestamp is out of range');
  switch (t.kind) {
    case 'dhm-zulu':
      return `${pad(t.day, 2)}${pad(t.hour, 2)}${pad(t.minute, 2)}z`;
    case 'dhm-local':
      return `${pad(t.day, 2)}${pad(t.hour, 2)}${pad(t.minute, 2)}/`;
    case 'hms':
      return `${pad(t.hour, 2)}${pad(t.minute, 2)}${pad(t.second, 2)}h`;
    case 'mdhm':
      return refuse('invalid-timestamp', 'a month/day/hour/minute timestamp is only for positionless weather reports');
  }
}

export function checkSymbol(symbol: AprsSymbol): void {
  if (symbol.code.length !== 1 || symbol.table.length !== 1) flag('invalid-symbol', 'a symbol is a table and a code, one character each');
  const code = symbol.code.charCodeAt(0);
  if (code < 0x21 || code > 0x7e) flag('invalid-symbol', 'the symbol code is not printable ASCII');
  const t = symbol.table;
  const ok = t === '/' || t === '\\' || (t >= '0' && t <= '9') || (t >= 'A' && t <= 'Z');
  if (!ok) flag('invalid-symbol', `the symbol table ${JSON.stringify(t)} is not /, \\, 0-9 or A-Z`);
}

export function base91(value: number, width: number): string {
  let v = value;
  let out = '';
  for (let i = 0; i < width; i++) {
    out = String.fromCharCode((v % 91) + 33) + out;
    v = Math.floor(v / 91);
  }
  return out;
}

/**
 * A number as plain decimal text: the shortest that reads back as the same number, with no
 * exponent and no `+`, a `0` before a leading point and no trailing `.0` (`0.53`, `-94`, 1e61 as
 * `1` and 61 zeros, 1e-7 as `0.0000001`; vectors rulings, F11).
 */
export function numberText(v: number): string {
  if (!Number.isFinite(v)) flag('not-a-number', 'a value is not a number');
  if (Object.is(v, -0)) return '0';
  const shortest = String(v);
  const m = /^(-?)([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/.exec(shortest);
  if (!m) return shortest;
  const sign = m[1]!;
  const digits = m[2]! + (m[3] ?? '');
  // The point sits after the first digit; the exponent moves it.
  const point = 1 + Number(m[4]);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
