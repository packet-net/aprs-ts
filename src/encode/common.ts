// Shared pieces of the encoder.

import { encodeUtf8Binary } from '../bytes.js';
import type { AprsSymbol, AprsTimestamp } from '../types.js';

/** Thrown when the encoder declines to write something the spec does not allow; says why. */
export class AprsEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AprsEncodeError';
  }
}

export function refuse(reason: string): never {
  throw new AprsEncodeError(reason);
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** A whole number within [min, max], else refused. */
export function whole(value: number, min: number, max: number, what: string): number {
  if (!Number.isFinite(value)) refuse(`${what} is not a number`);
  const n = Math.round(value);
  if (n < min || n > max) refuse(`${what} ${value} is out of range (${min}-${max})`);
  return n;
}

/** Free text as UTF-8 bytes (a binary string); refuses a line break, which receivers strip. */
export function freeText(text: string, what: string): string {
  if (/[\r\n]/.test(text)) refuse(`${what} contains a line break`);
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
  if (!isValidTimestamp(t)) refuse('the timestamp is out of range');
  switch (t.kind) {
    case 'dhm-zulu':
      return `${pad(t.day, 2)}${pad(t.hour, 2)}${pad(t.minute, 2)}z`;
    case 'dhm-local':
      return `${pad(t.day, 2)}${pad(t.hour, 2)}${pad(t.minute, 2)}/`;
    case 'hms':
      return `${pad(t.hour, 2)}${pad(t.minute, 2)}${pad(t.second, 2)}h`;
    case 'mdhm':
      return refuse('a month/day/hour/minute timestamp is only for positionless weather reports');
  }
}

export function checkSymbol(symbol: AprsSymbol, compressed: boolean): void {
  if (symbol.code.length !== 1 || symbol.table.length !== 1) refuse('a symbol is a table and a code, one character each');
  const code = symbol.code.charCodeAt(0);
  if (code < 0x21 || code > 0x7e) refuse('the symbol code is not printable ASCII');
  const t = symbol.table;
  const ok = t === '/' || t === '\\' || (t >= '0' && t <= '9') || (t >= 'A' && t <= 'Z');
  if (!ok) refuse(`the symbol table ${JSON.stringify(t)} is not /, \\, 0-9 or A-Z`);
  void compressed;
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

/** Formats a number as short text: `0.53`, `-32`, `1e-7`. */
export function numberText(v: number): string {
  if (!Number.isFinite(v)) refuse('a value is not a number');
  return String(v);
}
