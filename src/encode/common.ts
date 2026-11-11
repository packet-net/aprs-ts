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

  constructor(message: string, code: RefusalCode = 'does-not-read-back') {
    super(message);
    this.name = 'AprsEncodeError';
    this.code = code;
  }
}

export function refuse(code: RefusalCode, reason: string): never {
  throw new AprsEncodeError(reason, code);
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
  if (!Number.isFinite(value)) refuse('value-out-of-range', `${what} is not a number`);
  const n = nearest(value);
  if (n === noForm) refuse('value-has-no-form', `${what} ${value} is out of range (${min}-${max})`);
  if (n < min || n > max) refuse(outside, `${what} ${value} is out of range (${min}-${max})`);
  return n;
}

/** Free text as UTF-8 bytes (a binary string); refuses a line break, which receivers strip. */
export function freeText(text: string, what: string): string {
  if (/[\r\n]/.test(text)) refuse('invalid-character', `${what} contains a line break`);
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
  if (!isValidTimestamp(t)) refuse('invalid-timestamp', 'the timestamp is out of range');
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
  if (symbol.code.length !== 1 || symbol.table.length !== 1) refuse('invalid-symbol', 'a symbol is a table and a code, one character each');
  const code = symbol.code.charCodeAt(0);
  if (code < 0x21 || code > 0x7e) refuse('invalid-symbol', 'the symbol code is not printable ASCII');
  const t = symbol.table;
  const ok = t === '/' || t === '\\' || (t >= '0' && t <= '9') || (t >= 'A' && t <= 'Z');
  if (!ok) refuse('invalid-symbol', `the symbol table ${JSON.stringify(t)} is not /, \\, 0-9 or A-Z`);
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
  if (!Number.isFinite(v)) refuse('value-out-of-range', 'a value is not a number');
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
