// The encoder: writes only what the spec allows and refuses anything else with a reason. Free
// text is checked by decoding what was written: if the result does not read back as the same
// data (a comment that would read as an altitude, say), a `/` delimiter is tried, and if that
// does not help either the encoder refuses.

import { binaryToBytes, bytesToBinary, decodeUtf8 } from '../bytes.js';
import { decodeInformation } from '../decode/index.js';
import { formatDiagnostic, ParseOptions } from '../diagnostics.js';
import { isAprsIsAddress } from '../header.js';
import { toNeutralData } from '../neutral.js';
import type { AprsData, CompressionType, PathEntry } from '../types.js';
import { AprsEncodeError, refuse } from './common.js';
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
  encodeThirdParty,
  encodeUserDefined,
} from './other.js';
import { encodeItem, encodeMicE, encodeObject, encodePositionReport, encodeWeatherReport, type CommentMode } from './position.js';

export { AprsEncodeError } from './common.js';

/** An encoded information field, and for Mic-E the destination address it needs. */
export interface EncodedInformation {
  /** The information field bytes. */
  info: Uint8Array;
  /** Mic-E only: the destination address, which carries half the position. */
  destination?: string;
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
      const info = asReceived ? original : encodeInformation(inner).info;
      return { binary: encodeThirdParty(data, bytesToBinary(info)) };
    }
    case 'user-defined':
      return { binary: encodeUserDefined(data) };
    case 'test':
      return { binary: encodeTest(data) };
    case 'agrelo-df':
      return { binary: encodeAgrelo(data) };
    case 'unrecognized':
      return refuse('unrecognized data has nothing to encode');
  }
}

/** Numbers that agree within 1e-9, relative to the larger (absolute below 1). */
function sameNumber(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * (scale >= 1 ? scale : 1);
}

/**
 * Where the written data would read back differently: strings, booleans and which fields are
 * present, and with `numbers` the numbers too. Numbers are left out otherwise, because a value
 * given with more precision than the format carries is written to the format's precision.
 */
function shapeDifferences(a: unknown, b: unknown, path: string, out: string[], numbers: boolean): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (numbers && !sameNumber(a, b)) out.push(`${path.replace(/\.$/, '')} would read back as ${a}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path.replace(/\.$/, '')} would have ${a.length} items, not ${b.length}`);
    else a.forEach((x, i) => shapeDifferences(x, b[i], `${path}${i}.`, out, numbers));
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!(k in ao)) out.push(`${path}${k} would be lost`);
      else if (!(k in bo)) out.push(`${path}${k} would appear`);
      else shapeDifferences(ao[k], bo[k], `${path}${k}.`, out, numbers);
    }
    return;
  }
  if (a !== b) out.push(`${path.replace(/\.$/, '')} would read back as ${JSON.stringify(a)}`);
}

/** The data as it should read back: what the encoder fills in that the input may leave out. */
function expected(data: AprsData, a: Attempt): AprsData {
  let d = data;
  if ((d.type === 'position' || d.type === 'object' || d.type === 'item') && d.compressed && a.compression) {
    if (!d.compression) d = { ...d, compression: a.compression };
    if (d.courseDegrees !== undefined && d.speedKnots === undefined) d = { ...d, speedKnots: 0 };
  }
  if (d.type === 'mic-e') {
    if (d.speedKnots === undefined) d = { ...d, speedKnots: 0 };
    if (d.courseDegrees === 0) {
      const copy: Record<string, unknown> = { ...d };
      delete copy.courseDegrees;
      d = copy as unknown as AprsData;
    }
  }
  return d;
}

function check(data: AprsData, a: Attempt): string[] {
  const decoded = decodeInformation(binaryToBytes(a.binary), a.destination ?? 'APZ001', ParseOptions.lenient);
  const problems: string[] = [];
  const bad = decoded.diagnostics.filter((d) => d.severity !== 'info');
  if (bad.length > 0) problems.push(`it would read back with ${bad.map(formatDiagnostic).join(', ')}`);
  if (decoded.data.type !== data.type) {
    problems.push(`it would read back as ${decoded.data.type}`);
    return problems;
  }
  // An NMEA sentence is written as it is, so everything read from it must be what the data says.
  shapeDifferences(toNeutralData(decoded.data), toNeutralData(expected(data, a)), '', problems, data.type === 'nmea');
  return problems;
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
    // The comment would read as something else: try it straight after a frequency, then after a /.
    for (const mode of ['joined', 'delimited'] as const) {
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
  if (problems.length > 0) refuse(`it would not read back the same: ${problems.join('; ')}`);
  const out: EncodedInformation = { info: binaryToBytes(chosen.binary) };
  if (chosen.destination !== undefined) out.destination = chosen.destination;
  return out;
}

/** A packet to encode. */
export interface PacketToEncode {
  source: string;
  /** The destination (tocall); ignored for Mic-E, which computes it. Defaults to `APZ001`. */
  destination?: string;
  /** Digipeater path, e.g. `['WIDE1-1', 'WIDE2-1']`; a trailing `*` marks an entry used. */
  path?: readonly (string | PathEntry)[];
  data: AprsData;
}

function pathText(entry: string | PathEntry): string {
  return typeof entry === 'string' ? entry : entry.used ? `${entry.address}*` : entry.address;
}

function resolve(p: PacketToEncode): { destination: string; info: Uint8Array; path: string[] } {
  const encoded = encodeInformation(p.data);
  const destination = encoded.destination ?? p.destination ?? 'APZ001';
  return { destination, info: encoded.info, path: (p.path ?? []).map(pathText) };
}

/** Encodes a packet as the bytes of a TNC2 / APRS-IS line (the information field as sent). */
export function encodeTnc2Bytes(p: PacketToEncode): Uint8Array {
  const r = resolve(p);
  if (!isAprsIsAddress(p.source)) refuse(`the source ${JSON.stringify(p.source)} is not a valid address`);
  if (!isAprsIsAddress(r.destination)) refuse(`the destination ${JSON.stringify(r.destination)} is not a valid address`);
  for (const e of r.path) if (!isAprsIsAddress(e.replace(/\*$/, ''))) refuse(`the path entry ${JSON.stringify(e)} is not a valid address`);
  const header = [`${p.source}>${r.destination}`, ...r.path].join(',') + ':';
  const out = new Uint8Array(header.length + r.info.length);
  out.set(binaryToBytes(header), 0);
  out.set(r.info, header.length);
  return out;
}

/**
 * Encodes a packet as a TNC2 / APRS-IS line of text. User-defined data that is not UTF-8 has no
 * text form; use `encodeTnc2Bytes` for that.
 */
export function encodeTnc2(p: PacketToEncode): string {
  const text = decodeUtf8(encodeTnc2Bytes(p));
  if (text === undefined) refuse('the information field is not UTF-8 text; use encodeTnc2Bytes');
  return text;
}

function ax25Address(text: string, last: boolean, flag: boolean): number[] {
  const m = /^([A-Z0-9]{1,6})(?:-([0-9]{1,2}))?$/.exec(text);
  if (!m) refuse(`${JSON.stringify(text)} is not an AX.25 address`);
  const ssid = m[2] === undefined ? 0 : Number(m[2]);
  if (ssid > 15) refuse(`${JSON.stringify(text)} has an SSID over 15`);
  const call = m[1]!.padEnd(6, ' ');
  const out = Array.from(call, (c) => c.charCodeAt(0) << 1);
  out.push(0x60 | (ssid << 1) | (flag ? 0x80 : 0) | (last ? 1 : 0));
  return out;
}

/** Encodes a packet as an AX.25 UI frame in KISS form (no flags, no FCS). */
export function encodeAx25(p: PacketToEncode): Uint8Array {
  const r = resolve(p);
  const path = p.path ?? [];
  if (path.length > 8) refuse('AX.25 allows at most 8 digipeaters');
  const bytes: number[] = [];
  bytes.push(...ax25Address(r.destination, false, true));
  bytes.push(...ax25Address(p.source, path.length === 0, false));
  path.forEach((e, i) => {
    const address = typeof e === 'string' ? e.replace(/\*$/, '') : e.address;
    const used = typeof e === 'string' ? e.endsWith('*') : e.used;
    bytes.push(...ax25Address(address, i === path.length - 1, used));
  });
  bytes.push(0x03, 0xf0, ...r.info);
  return Uint8Array.from(bytes);
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
