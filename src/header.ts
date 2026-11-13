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

/** A third-party source: 1-9 printable ASCII characters (APRS12c ch. 17); `>` and `:` end it. */
const THIRD_PARTY_SOURCE = /^[\x20-\x7e]{1,9}$/;

/**
 * Parses `SOURCE>DEST,PATH` (without the colon). Used for TNC2 lines and third-party headers,
 * whose source need not be an APRS-IS address (`thirdParty`).
 */
export function parseHeaderText(
  header: string,
  options: ParseOptions,
  diags: Diagnostic[],
  thirdParty = false,
): { source: string; destination: string; path: PathEntry[] } {
  const gt = header.indexOf('>');
  if (gt < 0) fail(diags, 'invalid-header');
  const source = header.slice(0, gt);
  if (source.length === 0) fail(diags, 'invalid-header');
  if (!(thirdParty ? THIRD_PARTY_SOURCE : APRS_IS_ADDRESS).test(source)) fail(diags, 'invalid-address');
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

const Q_CONSTRUCT = /^qA[A-Za-z]$/;

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

/** Where an AX.25 address sits in the frame, which decides what an empty one is. */
type Ax25Role = 'destination' | 'source' | 'path';

function decodeAx25Address(
  frame: Uint8Array,
  offset: number,
  role: Ax25Role,
  options: ParseOptions,
  diags: Diagnostic[],
): Ax25Address {
  // The call is upper-case letters and digits, padded at the end with spaces (or NULs, tolerated)
  // (AX.25 2.2 section 3.12). A lower-case letter is tolerated; anything else, a space before the
  // last character included, would write a TNC2 header that reads back as a different one.
  const chars: number[] = [];
  for (let i = 0; i < 6; i++) chars.push(frame[offset + i]! >> 1);
  let end = 6;
  while (end > 0 && (chars[end - 1] === 0x20 || chars[end - 1] === 0x00)) end--;
  const nulPadded = chars.slice(end).includes(0x00);
  let lower = false;
  let call = '';
  for (let i = 0; i < end; i++) {
    const c = chars[i]!;
    if (c >= 0x61 && c <= 0x7a) lower = true;
    else if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) fail(diags, 'invalid-address');
    call += String.fromCharCode(c);
  }
  if (nulPadded) tolerate(options, diags, 'nul-padded-address');
  const ssidByte = frame[offset + 6]!;
  const flag = (ssidByte & 0x80) !== 0;
  const last = (ssidByte & 0x01) !== 0;
  if (call.length === 0) {
    // A call of spaces only is empty, as an empty TNC2 address is.
    if (role === 'source') fail(diags, 'invalid-address');
    tolerate(options, diags, role === 'destination' ? 'empty-destination' : 'empty-path-entry');
    return { text: '', flag, last };
  }
  if (lower) tolerate(options, diags, 'invalid-ax25-address-characters');
  const ssid = (ssidByte >> 1) & 0x0f;
  return { text: ssid === 0 ? call : `${call}-${ssid}`, flag, last };
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
      const role: Ax25Role = addresses.length === 0 ? 'destination' : addresses.length === 1 ? 'source' : 'path';
      const address = decodeAx25Address(frame, offset, role, options, diags);
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
    const path = markUsed(digis.map((d) => ({ address: d.text, marked: d.flag }))).filter((e) => e.address !== '');
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
