// Helpers for running the conformance vectors (vectors/README.md, "Checking a case").

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AprsHeaderError,
  decodeAx25,
  decodeTnc2,
  encodeUtf8,
  formatDiagnostic,
  hexToBytes,
  ParseOptions,
  toNeutralData,
  toNeutralHeader,
  type AprsPacket,
  type TolerableCode,
} from '../src/index.js';

/** The vectors: the submodule, or another checkout given by APRS_VECTORS (with a trailing /). */
export const VECTORS_DIR = process.env.APRS_VECTORS ?? fileURLToPath(new URL('../vectors/', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Case = Record<string, any>;

export interface CaseFile {
  file: string;
  cases: Case[];
}

export function loadCases(): CaseFile[] {
  const dir = `${VECTORS_DIR}cases/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, cases: JSON.parse(readFileSync(dir + file, 'utf8')).cases as Case[] }));
}

export function loadTolerable(): Set<string> {
  const codes = JSON.parse(readFileSync(`${VECTORS_DIR}codes.json`, 'utf8')).codes as { id: string; tolerable: boolean }[];
  return new Set(codes.filter((c) => c.tolerable).map((c) => c.id));
}

/** A decode case's input as the bytes to decode. */
export interface DecodeInput {
  kind: 'tnc2' | 'ax25';
  bytes: Uint8Array;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function decodeInput(input: Case): DecodeInput {
  if (input.tnc2 !== undefined) return { kind: 'tnc2', bytes: encodeUtf8(input.tnc2) };
  if (input.tnc2_hex !== undefined) return { kind: 'tnc2', bytes: hexToBytes(input.tnc2_hex) };
  if (input.ax25_hex !== undefined) return { kind: 'ax25', bytes: hexToBytes(input.ax25_hex) };
  const info = input.info !== undefined ? encodeUtf8(input.info) : hexToBytes(input.info_hex);
  const source = input.source ?? 'N0CALL';
  const destination = input.destination ?? 'APZ001';
  const path = input.path && input.path.length > 0 ? `,${input.path.join(',')}` : '';
  return { kind: 'tnc2', bytes: concat(encodeUtf8(`${source}>${destination}${path}:`), info) };
}

/** A decoding in the neutral form, or the header error. */
export type Result = { header_error: string[] } | { header: Record<string, unknown>; data: Record<string, unknown>; diagnostics: string[]; packet: AprsPacket };

export function decode(input: DecodeInput, options: ParseOptions): Result {
  try {
    const packet = input.kind === 'tnc2' ? decodeTnc2(input.bytes, options) : decodeAx25(input.bytes, options);
    return {
      header: toNeutralHeader(packet),
      data: toNeutralData(packet.data),
      diagnostics: packet.diagnostics.map(formatDiagnostic),
      packet,
    };
  } catch (e) {
    if (e instanceof AprsHeaderError) return { header_error: e.diagnostics.map(formatDiagnostic) };
    throw e;
  }
}

/** Numbers agree within 1e-9, relative to the larger magnitude (absolute below 1). */
export function numberEqual(a: number, b: number): boolean {
  if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * (scale >= 1 ? scale : 1);
}

/** Where two neutral values differ, as paths; empty when they agree. */
export function differences(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!numberEqual(a, b)) out.push(`${path}: ${a} vs ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    else a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out));
  } else if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const k of new Set([...ka, ...kb])) {
      if (!(k in (a as object))) out.push(`${path}.${k}: missing (expected ${JSON.stringify((b as Record<string, unknown>)[k])})`);
      else if (!(k in (b as object))) out.push(`${path}.${k}: unexpected ${JSON.stringify((a as Record<string, unknown>)[k])}`);
      else differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    }
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  return out;
}

/** Multiset difference of diagnostics, ignoring info when `ignoreInfo`. */
export function diagnosticDifferences(actual: readonly string[], expected: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const d of actual) count.set(d, (count.get(d) ?? 0) + 1);
  for (const d of expected) count.set(d, (count.get(d) ?? 0) - 1);
  const out: string[] = [];
  for (const [d, n] of count) {
    if (n > 0) out.push(`extra ${d}${n > 1 ? ` x${n}` : ''}`);
    if (n < 0) out.push(`missing ${d}${n < -1 ? ` x${-n}` : ''}`);
  }
  return out;
}

/** Compares a result with an expectation `{data, diagnostics, header?, header_error?}`. */
export function compareResult(actual: Result, expected: Case): string[] {
  if (expected.header_error !== undefined) {
    if (!('header_error' in actual)) return [`expected a header error ${JSON.stringify(expected.header_error)}, got data ${JSON.stringify(actual.data)}`];
    return diagnosticDifferences(actual.header_error, expected.header_error).map((d) => `header_error ${d}`);
  }
  if ('header_error' in actual) return [`unexpected header error ${JSON.stringify(actual.header_error)}`];
  const out: string[] = [];
  differences(actual.data, expected.data, 'data', out);
  out.push(...diagnosticDifferences(actual.diagnostics, expected.diagnostics ?? []).map((d) => `diagnostics ${d}`));
  if (expected.header !== undefined) differences(actual.header, expected.header, 'header', out);
  return out;
}

/** The single tolerable code a case's lenient decoding used, if exactly one. */
export function singleTolerance(c: Case, tolerable: Set<string>): TolerableCode | undefined {
  const used = new Set<string>();
  for (const d of (c.expect.diagnostics ?? []) as string[]) {
    const [severity, code] = d.split(':');
    if (severity === 'warning' && tolerable.has(code!)) used.add(code!);
  }
  return used.size === 1 ? ([...used][0] as TolerableCode) : undefined;
}

/** The expected strict result, as an expectation for `compareResult`, or a rejection. */
export function strictExpectation(c: Case): { kind: 'same' | 'full'; expect: Case } | { kind: 'rejected'; code: string; header: boolean } {
  const strict = c.strict ?? 'same';
  if (strict === 'same') return { kind: 'same', expect: c.expect };
  if (strict.rejected_by !== undefined) return { kind: 'rejected', code: strict.rejected_by, header: strict.header === true };
  return { kind: 'full', expect: { data: strict.data, diagnostics: strict.diagnostics ?? [] } };
}

/** Checks a result against the strict expectation. */
export function checkStrict(actual: Result, c: Case): string[] {
  const exp = strictExpectation(c);
  if (exp.kind !== 'rejected') return compareResult(actual, exp.expect);
  const error = `error:${exp.code}`;
  if (exp.header) {
    if (!('header_error' in actual)) return [`expected the header rejected by ${exp.code}, got ${JSON.stringify(actual.data)} ${JSON.stringify(actual.diagnostics)}`];
    return actual.header_error.includes(error) ? [] : [`header error lacks ${error}: ${JSON.stringify(actual.header_error)}`];
  }
  if ('header_error' in actual) return [`expected rejection by ${exp.code}, got a header error ${JSON.stringify(actual.header_error)}`];
  const out: string[] = [];
  differences(actual.data, { type: 'unrecognized', reason: 'malformed' }, 'data', out);
  if (!actual.diagnostics.includes(error)) out.push(`diagnostics lack ${error}: ${JSON.stringify(actual.diagnostics)}`);
  return out;
}
