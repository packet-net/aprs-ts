// The packet header: TNC2 text (`SOURCE>DEST,PATH:`) and AX.25 frames in KISS form.

import { bytesToBinary } from './bytes.js';
import type { DiagnosticCode } from './codes.js';
import { diagnostic, type Diagnostic, type ParseOptions } from './diagnostics.js';
import type { PathEntry, QConstruct } from './types.js';

/** Thrown when a packet's header is unusable, so nothing can be decoded. */
export class AprsHeaderError extends Error {
  /** Why: the diagnostics, the last of them the error. */
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const last = diagnostics[diagnostics.length - 1];
    super(last ? last.message : 'The header is unusable.');
    this.name = 'AprsHeaderError';
    this.diagnostics = diagnostics;
  }
}

/** A parsed header and the information field that follows it. */
export interface ParsedHeader {
  source: string;
  destination: string;
  path: PathEntry[];
  /** The information field bytes. */
  info: Uint8Array;
  diagnostics: Diagnostic[];
}

class HeaderRejected {
  constructor(readonly code: DiagnosticCode) {}
}

function tolerate(options: ParseOptions, diags: Diagnostic[], code: DiagnosticCode): void {
  if (options.tolerates(code)) diags.push(diagnostic('warning', code));
  else {
    diags.push(diagnostic('error', code));
    throw new HeaderRejected(code);
  }
}

function fail(diags: Diagnostic[], code: DiagnosticCode): never {
  diags.push(diagnostic('error', code));
  throw new HeaderRejected(code);
}

const APRS_IS_ADDRESS = /^[A-Za-z0-9-]{1,9}$/;

/** Whether `text` is a valid APRS-IS address: 1-9 letters, digits or `-`. */
export function isAprsIsAddress(text: string): boolean {
  return APRS_IS_ADDRESS.test(text);
}

/**
 * Parses a TNC2 header from the bytes of a line; `info` is everything after the first `:`.
 * Throws `AprsHeaderError` when the header is unusable.
 */
export function parseTnc2Header(line: Uint8Array, options: ParseOptions): ParsedHeader {
  const diags: Diagnostic[] = [];
  try {
    const colon = line.indexOf(0x3a);
    if (colon < 0) fail(diags, 'invalid-header');
    const header = bytesToBinary(line, 0, colon);
    const info = line.subarray(colon + 1);
    const parsed = parseHeaderText(header, options, diags);
    return { ...parsed, info, diagnostics: diags };
  } catch (e) {
    if (e instanceof HeaderRejected) throw new AprsHeaderError(diags);
    throw e;
  }
}

/** Parses `SOURCE>DEST,PATH` (without the colon). Used for TNC2 lines and third-party headers. */
export function parseHeaderText(
  header: string,
  options: ParseOptions,
  diags: Diagnostic[],
): { source: string; destination: string; path: PathEntry[] } {
  const gt = header.indexOf('>');
  if (gt < 0) fail(diags, 'invalid-header');
  const source = header.slice(0, gt);
  if (source.length === 0) fail(diags, 'invalid-header');
  if (!APRS_IS_ADDRESS.test(source)) fail(diags, 'invalid-address');
  const parts = header.slice(gt + 1).split(',');
  const destination = parts[0]!;
  if (destination.length === 0) tolerate(options, diags, 'empty-destination');
  else if (!APRS_IS_ADDRESS.test(destination)) fail(diags, 'invalid-address');
  const raw: { address: string; marked: boolean }[] = [];
  for (let i = 1; i < parts.length; i++) {
    let entry = parts[i]!;
    let marked = false;
    if (entry.endsWith('*')) {
      marked = true;
      entry = entry.slice(0, -1);
    }
    if (entry.length === 0 && !marked) {
      tolerate(options, diags, 'empty-path-entry');
      continue;
    }
    if (!APRS_IS_ADDRESS.test(entry)) fail(diags, 'invalid-address');
    raw.push({ address: entry, marked });
  }
  const markedCount = raw.filter((e) => e.marked).length;
  if (markedCount > 1) tolerate(options, diags, 'multiple-used-markers');
  return { source, destination, path: markUsed(raw) };
}

function markUsed(raw: readonly { address: string; marked: boolean }[]): PathEntry[] {
  let last = -1;
  raw.forEach((e, i) => {
    if (e.marked) last = i;
  });
  return raw.map((e, i) => ({ address: e.address, used: i <= last }));
}

/** Formats a path as TNC2 text: only the last used entry is marked with `*`. */
export function formatPath(path: readonly PathEntry[]): string {
  let last = -1;
  path.forEach((e, i) => {
    if (e.used) last = i;
  });
  return path.map((e, i) => (i === last ? `${e.address}*` : e.address)).join(',');
}

/** Formats a header as TNC2 text, without the colon. */
export function formatTnc2Header(source: string, destination: string, path: readonly PathEntry[]): string {
  return path.length === 0 ? `${source}>${destination}` : `${source}>${destination},${formatPath(path)}`;
}

const Q_CONSTRUCT = /^qA[CXUoOSrRZI]$/;

/** The APRS-IS q-construct in a path, and the station after it. */
export function findQConstruct(path: readonly PathEntry[]): QConstruct | undefined {
  for (let i = 0; i < path.length; i++) {
    const address = path[i]!.address;
    if (Q_CONSTRUCT.test(address)) {
      const station = path[i + 1]?.address;
      return station === undefined ? { construct: address } : { construct: address, station };
    }
  }
  return undefined;
}

/** A decoded AX.25 address. */
interface Ax25Address {
  text: string;
  flag: boolean;
  last: boolean;
}

function decodeAx25Address(
  frame: Uint8Array,
  offset: number,
  options: ParseOptions,
  diags: Diagnostic[],
): Ax25Address {
  let call = '';
  let padding = false;
  let nulPadded = false;
  let badChars = false;
  for (let i = 0; i < 6; i++) {
    const b = frame[offset + i]!;
    const c = b >> 1;
    if (c === 0x20 || c === 0x00) {
      padding = true;
      if (c === 0x00) nulPadded = true;
      continue;
    }
    if (padding) badChars = true;
    const ch = String.fromCharCode(c);
    if (!/[A-Z0-9]/.test(ch)) badChars = true;
    call += ch;
  }
  if (nulPadded) tolerate(options, diags, 'nul-padded-address');
  if (badChars) tolerate(options, diags, 'invalid-ax25-address-characters');
  const ssidByte = frame[offset + 6]!;
  const ssid = (ssidByte >> 1) & 0x0f;
  return {
    text: ssid === 0 ? call : `${call}-${ssid}`,
    flag: (ssidByte & 0x80) !== 0,
    last: (ssidByte & 0x01) !== 0,
  };
}

/**
 * Parses an AX.25 UI frame in KISS form (no flags, no FCS). Throws `AprsHeaderError` when it is
 * not an APRS frame.
 */
export function parseAx25Frame(frame: Uint8Array, options: ParseOptions): ParsedHeader {
  const diags: Diagnostic[] = [];
  try {
    const addresses: Ax25Address[] = [];
    let offset = 0;
    for (;;) {
      if (offset + 7 > frame.length) fail(diags, 'not-aprs-frame');
      const address = decodeAx25Address(frame, offset, options, diags);
      addresses.push(address);
      offset += 7;
      if (address.last) break;
    }
    if (addresses.length < 2) fail(diags, 'not-aprs-frame');
    if (addresses.length > 10) fail(diags, 'too-many-digipeaters');
    if (offset + 2 > frame.length) fail(diags, 'not-aprs-frame');
    const control = frame[offset]!;
    const pid = frame[offset + 1]!;
    if ((control & ~0x10) !== 0x03 || pid !== 0xf0) fail(diags, 'not-aprs-frame');
    const [dest, src, ...digis] = addresses;
    const path = markUsed(digis.map((d) => ({ address: d.text, marked: d.flag })));
    return {
      source: src!.text,
      destination: dest!.text,
      path,
      info: frame.subarray(offset + 2),
      diagnostics: diags,
    };
  } catch (e) {
    if (e instanceof HeaderRejected) throw new AprsHeaderError(diags);
    throw e;
  }
}
