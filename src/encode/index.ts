// The encoder: writes only what the spec allows and refuses anything else with a reason. Free
// text is checked by decoding what was written: if the result does not read back as the same
// data (a comment that would read as an altitude, say), the comment is tried straight after a
// frequency, then after a `/` delimiter, and if neither helps the encoder refuses.

import { binaryToBytes, bytesToBinary, decodeUtf8 } from '../bytes.js';
import { decodeInformation } from '../decode/index.js';
import { formatDiagnostic, ParseOptions } from '../diagnostics.js';
import { isAprsIsAddress } from '../header.js';
import { toNeutralData } from '../neutral.js';
import type { RefusalCode } from '../codes.js';
import type { AprsData, CompressionType, PathEntry } from '../types.js';
import { AprsEncodeError, collect, flag, givenTwiceReason, DEFAULT_DESTINATION, firstRefusal, refuse } from './common.js';
import {
  encodeAck,
  encodeAgrelo,
  encodeBulletin,
  encodeCapabilities,
  encodeDirectedQuery,
  encodeMaidenhead,
  encodeMessage,
  encodeNmea,
  encodeQuery,
  encodeRawWeather,
  encodeStatus,
  encodeTelemetryBits,
  encodeTelemetryCoefficients,
  encodeTelemetryNames,
  encodeTelemetryReport,
  encodeTest,
  checkThirdPartyHeader,
  encodeThirdParty,
  encodeUserDefined,
} from './other.js';
import { DEFAULT_COMPRESSION, encodeItem, encodeMicE, encodeObject, encodePositionReport, encodeWeatherReport, type CommentMode } from './position.js';

export { AprsEncodeError, DEFAULT_DESTINATION } from './common.js';

/** An encoded information field, and for Mic-E the destination address it needs. */
export interface EncodedInformation {
  /** The information field bytes. */
  readonly information: Uint8Array;
  /** Mic-E only: the destination address, which carries half the position. */
  readonly destination?: string;
}

interface Attempt {
  binary: string;
  destination?: string;
  compression?: CompressionType;
}

function withCompression(b: { text: string; compression?: CompressionType }): Attempt {
  return b.compression ? { binary: b.text, compression: b.compression } : { binary: b.text };
}

function attempt(data: AprsData, mode: CommentMode): Attempt {
  return collect(() => attemptOnce(data, mode));
}

const INNER_HEADER_CODES: ReadonlySet<string> = new Set([
  'invalid-header',
  'invalid-address',
  'empty-destination',
  'empty-path-entry',
  'multiple-used-markers',
  'nul-padded-address',
  'invalid-ax25-address-characters',
]);

function attemptOnce(data: AprsData, mode: CommentMode): Attempt {
  const inner = (data as { weather?: unknown }).weather;
  for (const o of [data, inner]) {
    const why = typeof o === 'object' && o !== null ? givenTwiceReason(o) : undefined;
    if (why !== undefined) flag('value-given-twice', why);
  }
  switch (data.type) {
    case 'position':
      return withCompression(encodePositionReport(data, mode));
    case 'object':
      return withCompression(encodeObject(data, mode));
    case 'item':
      return withCompression(encodeItem(data, mode));
    case 'mic-e': {
      const m = encodeMicE(data, mode);
      return { binary: m.text, destination: m.destination };
    }
    case 'weather':
      return { binary: encodeWeatherReport(data) };
    case 'message':
      return { binary: encodeMessage(data) };
    case 'ack':
    case 'reject':
      return { binary: encodeAck(data) };
    case 'bulletin':
    case 'nws-bulletin':
      return { binary: encodeBulletin(data) };
    case 'telemetry-names':
    case 'telemetry-units':
      return { binary: encodeTelemetryNames(data) };
    case 'telemetry-coefficients':
      return { binary: encodeTelemetryCoefficients(data) };
    case 'telemetry-bits':
      return { binary: encodeTelemetryBits(data) };
    case 'directed-query':
      return { binary: encodeDirectedQuery(data) };
    case 'status':
      return { binary: encodeStatus(data) };
    case 'telemetry':
      return { binary: encodeTelemetryReport(data) };
    case 'raw-weather':
      return { binary: encodeRawWeather(data) };
    case 'nmea':
      return { binary: encodeNmea(data) };
    case 'maidenhead-beacon':
      return { binary: encodeMaidenhead(data) };
    case 'query':
      return { binary: encodeQuery(data) };
    case 'capabilities':
      return { binary: encodeCapabilities(data) };
    case 'third-party': {
      // The original information field must not be changed (APRS12c ch. 17).
      // An inner packet built by hand, with no information field, is encoded from its data.
      const original = data.packet.information;
      const inner = data.packet.data;
      const asReceived = original.length > 0 || (inner.type === 'unrecognized' && inner.reason === 'empty');
      // The inner header is checked before the inner data: the header is written first.
      checkThirdPartyHeader(data);
      // A defect the lenient decoder tolerated in the inner header is part of the data it read.
      if (data.packet.diagnostics.some((x) => x.severity !== 'info' && INNER_HEADER_CODES.has(x.code)))
        flag('invalid-third-party-header', 'the inner header has a defect that was tolerated when it was read');
      const info = asReceived ? original : encodeInformation(inner).information;
      return { binary: encodeThirdParty(data, bytesToBinary(info)) };
    }
    case 'user-defined':
      return { binary: encodeUserDefined(data) };
    case 'test':
      return { binary: encodeTest(data) };
    case 'agrelo-df':
      return { binary: encodeAgrelo(data) };
    case 'unrecognized':
      return refuse('not-encodable', 'unrecognized data has nothing to encode');
  }
}

/** Numbers that agree within 1e-9, relative to the larger (absolute below 1). */
function sameNumber(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * (scale >= 1 ? scale : 1);
}

/** A way the written data would read back differently, with the refusal code it earns. */
interface Problem {
  readonly code: RefusalCode;
  readonly text: string;
}

/** Fields that hold free text; one that reads back changed or lost is text that read as something else. */
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(['comment', 'text', 'data', 'project', 'software', 'unit', 'names', 'units', 'extra', 'status']);

function problem(code: RefusalCode, text: string): Problem {
  return { code, text };
}

/**
 * Where the written data would read back differently: strings, booleans and which fields are
 * present, and with `numbers` the numbers too. Numbers are left out otherwise, because a value
 * given with more precision than the format carries is written to the format's precision.
 */
function shapeDifferences(a: unknown, b: unknown, path: string, out: Problem[], numbers: boolean): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (numbers && !sameNumber(a, b)) out.push(problem('invalid-nmea', `${path.replace(/\.$/, '')} would read back as ${a}`));
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(problem('text-reads-as-field', `${path.replace(/\.$/, '')} would have ${a.length} items, not ${b.length}`));
    else a.forEach((x, i) => shapeDifferences(x, b[i], `${path}${i}.`, out, numbers));
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!(k in ao)) out.push(problem(FREE_TEXT_FIELDS.has(k) ? 'text-reads-as-field' : 'does-not-read-back', `${path}${k} would be lost`));
      else if (!(k in bo)) out.push(problem('text-reads-as-field', `${path}${k} would appear`));
      else shapeDifferences(ao[k], bo[k], `${path}${k}.`, out, numbers);
    }
    return;
  }
  if (a !== b) out.push(problem('text-reads-as-field', `${path.replace(/\.$/, '')} would read back as ${JSON.stringify(a)}`));
}

/** The data as it should read back: what the encoder fills in that the input may leave out. */
function expected(data: AprsData, a: Attempt): AprsData {
  let d = data;
  if ((d.type === 'position' || d.type === 'object' || d.type === 'item') && d.compressed && a.compression) {
    if (!d.compression) d = { ...d, compression: a.compression };
  }
  if (d.type === 'mic-e' && d.speedKnots === undefined) d = { ...d, speedKnots: 0 };
  if (d.type === 'third-party' && d.packet.information.length === 0) {
    // An inner packet written from its data: cs values with no compression type got the default.
    const inner = d.packet.data;
    if ((inner.type === 'position' || inner.type === 'object' || inner.type === 'item') && inner.compressed && !inner.compression) {
      const w = inner.weather;
      const carries =
        inner.courseDegrees !== undefined ||
        inner.speedKnots !== undefined ||
        inner.rangeMiles !== undefined ||
        (w !== undefined && (w.windDirectionDegrees !== undefined || w.windSpeedMph !== undefined));
      if (carries) d = { ...d, packet: { ...d.packet, data: { ...inner, compression: DEFAULT_COMPRESSION } } };
    }
  }
  return d;
}

function check(data: AprsData, a: Attempt): Problem[] {
  const decoded = decodeInformation(binaryToBytes(a.binary), a.destination ?? DEFAULT_DESTINATION, ParseOptions.lenient);
  const problems: Problem[] = [];
  const bad = decoded.diagnostics.filter((d) => d.severity !== 'info');
  if (bad.length > 0) problems.push(problem('text-reads-as-field', `it would read back with ${bad.map(formatDiagnostic).join(', ')}`));
  if (decoded.data.type !== data.type) {
    problems.push(problem('text-reads-as-field', `it would read back as ${decoded.data.type}`));
    return problems;
  }
  // An NMEA sentence is written as it is, so everything read from it must be what the data says.
  const shape: Problem[] = [];
  const got = withoutInnerInfo(toNeutralData(decoded.data));
  let want = withoutInnerInfo(toNeutralData(expected(data, a)));
  // NMEA data is its sentence: a field left out is the one the sentence gives (vectors
  // interpretations.md, NMEA data is its sentence).
  if (data.type === 'nmea') want = { ...got, ...want };
  shapeDifferences(got, want, '', shape, data.type === 'nmea');
  // Whatever differs in a sentence read back is a field that disagrees with it.
  for (const p of shape) problems.push(data.type === 'nmea' ? problem('invalid-nmea', p.text) : p);
  return problems;
}

/**
 * A third-party packet's neutral data without its inner packet's `info` diagnostics: an info is
 * not a defect, so an inner packet that reads back with only those is written (vectors rulings, F10).
 */
function withoutInnerInfo(n: Record<string, unknown>): Record<string, unknown> {
  const packet = n.packet as Record<string, unknown> | undefined;
  if (n.type !== 'third-party' || !packet || !Array.isArray(packet.diagnostics)) return n;
  const kept = (packet.diagnostics as string[]).filter((d) => !d.startsWith('info:'));
  const copy: Record<string, unknown> = { ...packet };
  if (kept.length > 0) copy.diagnostics = kept;
  else delete copy.diagnostics;
  return { ...n, packet: copy };
}

/**
 * Encodes data as an information field. Mic-E also gives the destination address it computed.
 * Throws `AprsEncodeError`, with the reason, for anything the spec does not allow.
 */
export function encodeInformation(data: AprsData): EncodedInformation {
  const first = attempt(data, 'plain');
  let problems = check(data, first);
  let chosen = first;
  if (problems.length > 0 && typeof (data as { comment?: unknown }).comment === 'string') {
    // The comment would read as something else: try it straight after a frequency, then after a
    // /, then after a space.
    for (const mode of ['joined', 'delimited', 'spaced'] as const) {
      let next: Attempt | undefined;
      try {
        next = attempt(data, mode);
      } catch (e) {
        if (!(e instanceof AprsEncodeError)) throw e;
      }
      if (next && next.binary !== first.binary && check(data, next).length === 0) {
        chosen = next;
        problems = [];
        break;
      }
    }
  }
  if (problems.length > 0) refuse(firstRefusal(problems).code, `it would not read back the same: ${problems.map((p) => p.text).join('; ')}`);
  const information = binaryToBytes(chosen.binary);
  return chosen.destination !== undefined ? { information, destination: chosen.destination } : { information };
}

/** A packet to encode. */
export interface PacketToEncode {
  source: string;
  /** The destination (tocall); ignored for Mic-E, which computes it. Defaults to `DEFAULT_DESTINATION` (`APZ001`). */
  destination?: string;
  /** Digipeater path, e.g. `['WIDE1-1', 'WIDE2-1']`; a trailing `*` marks an entry used. */
  path?: readonly (string | PathEntry)[];
  data: AprsData;
}

function pathText(entry: string | PathEntry): string {
  return typeof entry === 'string' ? entry : entry.used ? `${entry.address}*` : entry.address;
}

function resolve(p: PacketToEncode): { destination: string; information: Uint8Array; path: string[] } {
  const encoded = encodeInformation(p.data);
  const destination = encoded.destination ?? p.destination ?? DEFAULT_DESTINATION;
  return { destination, information: encoded.information, path: (p.path ?? []).map(pathText) };
}

/** Refuses a source, destination or path entry that APRS-IS does not allow as an address. */
export function checkHeaderAddresses(source: string, destination: string, path: readonly string[]): void {
  if (!isAprsIsAddress(source)) refuse('invalid-address', `the source ${JSON.stringify(source)} is not a valid address`);
  if (!isAprsIsAddress(destination)) refuse('invalid-address', `the destination ${JSON.stringify(destination)} is not a valid address`);
  for (const e of path) if (!isAprsIsAddress(e.replace(/\*$/, ''))) refuse('invalid-address', `the path entry ${JSON.stringify(e)} is not a valid address`);
}

/** A TNC2 line from a header and an information field already encoded; the addresses are not checked. */
export function tnc2BytesOf(source: string, destination: string, path: readonly string[], information: Uint8Array): Uint8Array {
  const header = [`${source}>${destination}`, ...path].join(',') + ':';
  const out = new Uint8Array(header.length + information.length);
  out.set(binaryToBytes(header), 0);
  out.set(information, header.length);
  return out;
}

/** A TNC2 line as text; refuses an information field that is not UTF-8. */
export function tnc2TextOf(bytes: Uint8Array): string {
  const text = decodeUtf8(bytes);
  if (text === undefined) refuse('tnc2-cannot-carry', 'the information field is not UTF-8 text; use encodeTnc2Bytes');
  return text;
}

/** Encodes a packet as the bytes of a TNC2 / APRS-IS line (the information field as sent). */
export function encodeTnc2Bytes(p: PacketToEncode): Uint8Array {
  const r = resolve(p);
  checkHeaderAddresses(p.source, r.destination, r.path);
  return tnc2BytesOf(p.source, r.destination, r.path, r.information);
}

/**
 * Encodes a packet as a TNC2 / APRS-IS line of text. User-defined data that is not UTF-8 has no
 * text form; use `encodeTnc2Bytes` for that.
 */
export function encodeTnc2(p: PacketToEncode): string {
  return tnc2TextOf(encodeTnc2Bytes(p));
}

function ax25Address(text: string, last: boolean, flag: boolean): number[] {
  const m = /^([A-Z0-9]{1,6})(?:-([0-9]{1,2}))?$/.exec(text);
  if (!m) refuse('ax25-cannot-carry', `${JSON.stringify(text)} is not an AX.25 address`);
  if (m[2] !== undefined && m[2].startsWith('0')) refuse('ax25-cannot-carry', `${JSON.stringify(text)} has a leading zero or a zero in its SSID, which a frame would give back without it`);
  const ssid = m[2] === undefined ? 0 : Number(m[2]);
  if (ssid > 15) refuse('ax25-cannot-carry', `${JSON.stringify(text)} has an SSID over 15`);
  const call = m[1]!.padEnd(6, ' ');
  const out = Array.from(call, (c) => c.charCodeAt(0) << 1);
  out.push(0x60 | (ssid << 1) | (flag ? 0x80 : 0) | (last ? 1 : 0));
  return out;
}

/** An AX.25 UI frame from a header and an information field already encoded. */
export function ax25Of(source: string, destination: string, path: readonly (string | PathEntry)[], information: Uint8Array): Uint8Array {
  if (path.length > 8) refuse('ax25-cannot-carry', 'AX.25 allows at most 8 digipeaters');
  const bytes: number[] = [];
  bytes.push(...ax25Address(destination, false, true));
  bytes.push(...ax25Address(source, path.length === 0, false));
  path.forEach((e, i) => {
    const address = typeof e === 'string' ? e.replace(/\*$/, '') : e.address;
    const used = typeof e === 'string' ? e.endsWith('*') : e.used;
    bytes.push(...ax25Address(address, i === path.length - 1, used));
  });
  bytes.push(0x03, 0xf0, ...information);
  return Uint8Array.from(bytes);
}

/** Encodes a packet as an AX.25 UI frame in KISS form (no flags, no FCS). */
export function encodeAx25(p: PacketToEncode): Uint8Array {
  const r = resolve(p);
  return ax25Of(p.source, r.destination, p.path ?? [], r.information);
}

/** Wraps an AX.25 frame for a KISS TNC: FEND, a data command on `port`, escaping, FEND. */
export function wrapKiss(frame: Uint8Array, port = 0): Uint8Array {
  const out: number[] = [0xc0, (port & 0x0f) << 4];
  for (const b of frame) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return Uint8Array.from(out);
}
