// The encoder: writes only what the spec allows and refuses anything else with a reason. Every
// information field leaves through `finish`, which ends in the read-back (`readback.ts`): the
// bytes are decoded and compared with the data given, the next equivalent form is tried if they do
// not match (a comment straight on, then after a `/`, then after a space), and the data is refused
// if none matches. The header writers (`tnc2BytesOf`, `ax25Of`) judge the header given and read
// their own header back the same way. Nothing decides whether either runs.

import { binaryToBytes, bytesToBinary, decodeUtf8 } from '../bytes.js';
import { formatDiagnostic, ParseOptions, type Diagnostic } from '../diagnostics.js';
import { AprsHeaderError, formatTnc2Header, isAprsIsAddress, parseAx25Frame, readHeaderText, type ParsedHeader } from '../header.js';
import type { AprsData, CompressionType, PathEntry } from '../types.js';
import { AprsEncodeError, collect, flag, givenTwiceReason, flagLate, DEFAULT_DESTINATION, firstRefusal, refuse, refusalRank } from './common.js';
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
import { decodeInformation } from '../decode/index.js';
import { toNeutralData } from '../neutral.js';
import { readBack, sameData } from './readback.js';
import { checkShape, guarded, pendingShapeFaults, strayFields } from './shape.js';
import { encodeItem, encodeMicE, encodeObject, micEAltitudeHasNextForm, encodePositionReport, encodeWeatherReport, type CommentMode } from './position.js';

export { AprsEncodeError, DEFAULT_DESTINATION } from './common.js';

/** An encoded information field, and for Mic-E the destination address it needs. */
export interface EncodedInformation {
  /** The information field bytes. */
  readonly information: Uint8Array;
  /** Mic-E only: the destination address, which carries half the position. */
  readonly destination?: string;
}

/**
 * What only a builder asks the encoder for, passed as an argument and kept on no object a caller
 * can see or copy: a Mic-E altitude goes in the Mic-E bytes first, whatever the data.
 */
export interface WriteOptions {
  readonly micEBytesFirst?: boolean;
}

interface Attempt {
  binary: string;
  destination?: string;
  compression?: CompressionType;
}

function withCompression(b: { text: string; compression?: CompressionType }): Attempt {
  return b.compression ? { binary: b.text, compression: b.compression } : { binary: b.text };
}

/** The most bytes an information field holds (APRS12c ch. 3). */
const MAX_INFORMATION_BYTES = 256;

function attempt(data: AprsData, mode: CommentMode, options: WriteOptions, altitudeForm?: 'bytes' | 'text'): Attempt {
  return collect(() => {
    return attemptOnce(data, mode, options, altitudeForm);
  });
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

/**
 * Whether a number anywhere in the data, at any depth (a third-party packet's inner data and every
 * list included), is NaN or an infinity. Walked with a stack, once, so no field can be missed.
 */
function holdsNonFinite(root: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return true;
    } else if (typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !seen.has(v)) {
      seen.add(v);
      for (const x of Object.values(v)) stack.push(x);
    }
  }
  return false;
}

function attemptOnce(data: AprsData, mode: CommentMode, options: WriteOptions, altitudeForm?: 'bytes' | 'text'): Attempt {
  // A number that is not a number is refused wherever it is, whatever the field: never compared as absent.
  if (holdsNonFinite(data)) flag('not-a-number', 'a value is NaN or an infinity');
  // A field the type has no place for is refused, not dropped.
  for (const k of strayFields(data as unknown as Record<string, unknown>)) flag('field-not-allowed', `a ${data.type} has no ${k}`);
  // A required field left out or of the wrong kind, held until the rest is checked.
  for (const e of pendingShapeFaults(data)) flag(e.code, e.message);
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
      const m = encodeMicE(data, mode, altitudeForm, options.micEBytesFirst === true);
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
      // The inner packet is read under its own inner destination: an information field held with
      // a header it does not read as its data under, or Mic-E data whose inner destination is not
      // the one it computes, is not data this call can write (the computed destination is never
      // put in the place of the one given).
      let info: Uint8Array;
      if (asReceived) {
        if (!readsAsHeld(original, data.packet.destination, inner)) flagLate('not-encodable', `the inner data and the inner information field disagree: the field would read as other data under the destination ${JSON.stringify(data.packet.destination)}`);
        info = original;
      } else {
        let encoded: EncodedInformation;
        try {
          encoded = encodeInformation(inner);
        } catch (e) {
          // Past every rule check, Mic-E data under a destination it does not compute is
          // not-encodable, which the Refusal reasons order puts before what the read-back found.
          if (!(e instanceof AprsEncodeError) || inner.type !== 'mic-e' || refusalRank(e.code) < refusalRank('text-reads-as-field')) throw e;
          const destination = attempt(checkShape(inner), 'plain', {}).destination;
          if (destination === data.packet.destination) throw e;
          encoded = { information: new Uint8Array(), destination };
        }
        if (encoded.destination !== undefined && encoded.destination !== data.packet.destination)
          flagLate('not-encodable', `inner Mic-E data computes the destination ${encoded.destination}, not ${JSON.stringify(data.packet.destination)}`);
        info = encoded.information;
      }
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

/**
 * Whether an information field, read under the destination it is written with, reads as the data
 * it is held with, for every kind of data. This refuses a held packet whose data, header or
 * information bytes no longer agree: a position whose latitude was changed, status text changed, an
 * inner packet re-addressed at any depth, or a Mic-E packet re-addressed to or from a Mic-E destination.
 */
export function readsAsHeld(information: Uint8Array, destinationWritten: string, heldData: AprsData): boolean {
  // The innermost level of a nest five or more deep is held as unrecognized for the unread fifth `}`:
  // on its own the field starts a third-party packet and reads as more than was held.
  if (heldData.type === 'unrecognized' && heldData.reason === 'malformed' && information[0] === 0x7d) return true;
  const decoded = decodeInformation(information, destinationWritten, ParseOptions.lenient).data;
  if (decoded.type !== heldData.type) return false;
  const [data, read] = withoutUnreadLevel(heldData, decoded);
  // Data decoded from these bytes reads back exactly as held, whatever form the report is in (a
  // compressed report's range or wind in whole units in its comment is not rounded to cs steps).
  if (JSON.stringify(toNeutralData(read)) === JSON.stringify(toNeutralData(data))) return true;
  // Data a program made (a Mic-E report whose latitude lies between steps) reads back by the read-back's own allowances.
  return sameData(data, read);
}

/**
 * A held level that is `unrecognized` for an unread fifth `}` matches whatever the field decodes to
 * there on its own (the inner packet of a nest five or more deep, written on its own): that level's
 * data and diagnostics are left out of both sides.
 */
function withoutUnreadLevel(held: AprsData, read: AprsData): [AprsData, AprsData] {
  if (held.type !== 'third-party' || read.type !== 'third-party') return [held, read];
  const h = held.packet;
  const r = read.packet;
  if (h.data.type === 'unrecognized' && h.data.reason === 'malformed' && h.diagnostics.some((d) => d.severity === 'error' && d.code === 'invalid-third-party')) {
    const blank = { data: { type: 'unrecognized', reason: 'malformed' } as AprsData, diagnostics: [] };
    return [{ ...held, packet: { ...h, ...blank } }, { ...read, packet: { ...r, ...blank } }];
  }
  const [hd, rd] = withoutUnreadLevel(h.data, r.data);
  return hd === h.data && rd === r.data ? [held, read] : [{ ...held, packet: { ...h, data: hd } }, { ...read, packet: { ...r, data: rd } }];
}

/** Refuses (`not-encodable`) a held information field that reads as other data under the destination it is written with. */
export function checkReadsAsHeld(information: Uint8Array, destination: string, data: AprsData): void {
  if (!readsAsHeld(information, destination, data)) refuse('not-encodable', `the data and the information field disagree: the field would read as other data under the destination ${JSON.stringify(destination)}`);
}

/**
 * Encodes data as an information field. Mic-E also gives the destination address it computed.
 * Throws `AprsEncodeError`, with the reason, for anything the spec does not allow.
 */
export function encodeInformation(data: AprsData): EncodedInformation {
  return encodeInformationWith(data, {});
}

/** `encodeInformation` with what only a builder asks for; not part of the public API. */
export function encodeInformationWith(data: AprsData, options: WriteOptions): EncodedInformation {
  return guarded(() => encodeShaped(checkShape(data), options));
}

/** Whether the attempt reads back with the frequency it was given, fields and all (the choice between equivalent forms of a Mic-E comment). */
function readsBackWithItsFrequency(data: AprsData, a: Attempt): boolean {
  if ((data as { frequency?: unknown }).frequency === undefined) return false;
  return readBack(data, a.binary, a.destination).every((p) => !p.text.startsWith('frequency'));
}

/**
 * The one place bytes leave the encoder: the final read-back, then the size, in that order. Every
 * public function that writes an information field from data ends here, whatever the report.
 */
function finish(data: AprsData, first: Attempt, options: WriteOptions): EncodedInformation {
  let problems = readBack(data, first.binary, first.destination);
  let chosen = first;
  if (problems.length > 0) {
    // The next forms the Encoding rule names: the comment straight on to a frequency, then after
    // a /, then after a space; and for a Mic-E altitude written in the bytes, a /A= that holds it
    // exactly, each with the same three ways of joining the comment.
    // Free text after a frequency follows a space. It goes straight on to the frequency only
    // when the space would make it read as more frequency fields; when the frequency reads back
    // whole and the text does not (a Mic-E ' X' at the end is the device suffix), it takes a /.
    const hasComment = typeof (data as { comment?: unknown }).comment === 'string';
    const commentModes = data.type === 'mic-e' && readsBackWithItsFrequency(data, first) ? (['delimited', 'joined', 'spaced'] as const) : (['joined', 'delimited', 'spaced'] as const);
    const tries: { form: 'bytes' | 'text' | undefined; mode: CommentMode }[] = [];
    if (hasComment) for (const mode of commentModes) tries.push({ form: undefined, mode });
    if (data.type === 'mic-e' && micEAltitudeHasNextForm(data, options.micEBytesFirst === true)) {
      tries.push({ form: 'text', mode: 'plain' });
      if (hasComment) for (const mode of commentModes) tries.push({ form: 'text', mode });
    }
    for (const t of tries) {
      let next: Attempt | undefined;
      try {
        next = attempt(data, t.mode, options, t.form);
      } catch (e) {
        if (!(e instanceof AprsEncodeError)) throw e;
      }
      if (next && next.binary !== first.binary && readBack(data, next.binary, next.destination).length === 0) {
        chosen = next;
        problems = [];
        break;
      }
    }
  }
  if (problems.length > 0) refuse(firstRefusal(problems).code, `it would not read back the same: ${problems.map((p) => p.text).join('; ')}`);
  // The size is the last check, on the bytes actually written: a record any other rule refuses
  // has been refused above, with that rule's code.
  if (chosen.binary.length > MAX_INFORMATION_BYTES)
    throw new AprsEncodeError(`the information field is ${chosen.binary.length} bytes; at most ${MAX_INFORMATION_BYTES} are allowed`, 'information-field-too-long');
  const information = binaryToBytes(chosen.binary);
  return chosen.destination !== undefined ? { information, destination: chosen.destination } : { information };
}

function encodeShaped(data: AprsData, options: WriteOptions): EncodedInformation {
  return finish(data, attempt(data, 'plain', options), options);
}

/** A packet to encode. */
export interface PacketToEncode {
  source: string;
  /** The destination (tocall); ignored for Mic-E, which computes it. Defaults to `DEFAULT_DESTINATION` (`APZ001`). */
  destination?: string;
  /** Digipeater path, e.g. `['WIDE1-1', 'WIDE2-1']`; a trailing `*` marks an entry used, on every used entry. */
  path?: readonly (string | PathEntry)[];
  data: AprsData;
}

/** A path as entries: a string ending in `*` is a used entry, as the neutral header form writes it. */
export function pathEntries(path: readonly (string | PathEntry)[]): PathEntry[] {
  return path.map((e) => (typeof e !== 'string' ? { address: e.address, used: Boolean(e.used) } : e.endsWith('*') ? { address: e.slice(0, -1), used: true } : { address: e, used: false }));
}

function pathText(entry: PathEntry): string {
  return entry.used ? `${entry.address}*` : entry.address;
}

/** The destination to check before the data is encoded: a Mic-E one is computed, and always valid. */
function givenDestination(p: PacketToEncode): string {
  return (p.data as { type?: unknown } | undefined)?.type === 'mic-e' ? DEFAULT_DESTINATION : (p.destination ?? DEFAULT_DESTINATION);
}

function resolve(p: PacketToEncode): { destination: string; information: Uint8Array; path: PathEntry[] } {
  const encoded = encodeInformation(p.data);
  const destination = encoded.destination ?? p.destination ?? DEFAULT_DESTINATION;
  return { destination, information: encoded.information, path: pathEntries(p.path ?? []) };
}

/**
 * Judges a header as it is given, before any data is looked at and whatever form is written:
 * `invalid-address` for a source, destination or path entry APRS-IS does not allow as an address,
 * then `invalid-path` for a path whose entry not marked used comes before one that is (no line or
 * frame reads that back, and no decoder gives it). A packet already held is written as received, so
 * its empty destination is let through here (`mayBeEmpty`): a TNC2 line carries it, a frame refuses it.
 */
export function checkHeaderAddresses(source: string, destination: string, path: readonly (string | PathEntry)[], mayBeEmpty = false): void {
  if (!isAprsIsAddress(source)) refuse('invalid-address', `the source ${JSON.stringify(source)} is not a valid address`);
  if (!(mayBeEmpty && destination === '') && !isAprsIsAddress(destination)) refuse('invalid-address', `the destination ${JSON.stringify(destination)} is not a valid address`);
  const entries = pathEntries(path);
  for (const e of entries) if (!isAprsIsAddress(e.address)) refuse('invalid-address', `the path entry ${JSON.stringify(pathText(e))} is not a valid address`);
  const lastUsed = entries.map((e) => e.used).lastIndexOf(true);
  for (let i = 0; i < lastUsed; i++) {
    if (!entries[i]!.used) refuse('invalid-path', `the path entry ${JSON.stringify(entries[i]!.address)} is not marked used but comes before a used one, and an entry before a used one is used: mark it used (${JSON.stringify(entries[i]!.address + '*')})`);
  }
}

/**
 * Where a header read back differs from the header given: source, destination and path entry by
 * entry, each with its used mark, and no diagnostic. A decoded packet's empty destination (a
 * tolerated defect) is the one thing a header of a packet already held may carry that a header
 * written from data never does.
 */
export function headerDifference(read: { source: string; destination: string; path: readonly PathEntry[]; diagnostics: readonly Diagnostic[] }, source: string, destination: string, path: readonly PathEntry[]): string | undefined {
  if (read.source !== source) return `the source would read back as ${JSON.stringify(read.source)}`;
  if (read.destination !== destination) return `the destination would read back as ${JSON.stringify(read.destination)}`;
  if (read.path.length !== path.length) return `the path would have ${read.path.length} entries, not ${path.length}`;
  for (let i = 0; i < path.length; i++) {
    const given = path[i]!;
    const got = read.path[i]!;
    if (got.address !== given.address || got.used !== given.used)
      return `the path entry ${JSON.stringify(pathText(given))} would read back as ${JSON.stringify(pathText(got))}`;
  }
  const bad = read.diagnostics.filter((d) => !(destination === '' && d.code === 'empty-destination'));
  if (bad.length > 0) return `the header would read back with ${bad.map(formatDiagnostic).join(', ')}`;
  return undefined;
}

/** Whether the information field holds a CR or LF before the line breaks at its very end, which a decoder takes off. */
function holdsLineBreak(information: Uint8Array): boolean {
  let end = information.length;
  while (end > 0 && (information[end - 1] === 0x0d || information[end - 1] === 0x0a)) end--;
  for (let i = 0; i < end; i++) if (information[i] === 0x0d || information[i] === 0x0a) return true;
  return false;
}

/**
 * A TNC2 / APRS-IS line from a header and an information field. The header is judged as given
 * (`invalid-address`, `invalid-path`), written (`*` on the last used entry only) and read back as an
 * outer header is read, and refused `tnc2-cannot-carry` if it reads back as another. A line ends at a
 * CR or LF, so an information field holding one before its very end is refused `tnc2-cannot-carry`
 * too. The information field is otherwise written as it stands: an encoder's has passed its own
 * read-back, a received packet's is passed through.
 */
export function tnc2BytesOf(source: string, destination: string, path: readonly (string | PathEntry)[], information: Uint8Array): Uint8Array {
  const entries = pathEntries(path);
  checkHeaderAddresses(source, destination, entries, true);
  const header = formatTnc2Header(source, destination, entries);
  const read = readHeaderText(header, ParseOptions.lenient);
  if (read === undefined) refuse('tnc2-cannot-carry', `the header ${JSON.stringify(header)} would not read back`);
  const why = headerDifference(read, source, destination, entries);
  if (why !== undefined) refuse('tnc2-cannot-carry', `a TNC2 line cannot carry this header: ${why}`);
  if (holdsLineBreak(information)) refuse('tnc2-cannot-carry', 'a TNC2 line ends at a CR or LF, and the information field holds one before its end');
  const headerBytes = binaryToBytes(header + ':');
  const out = new Uint8Array(headerBytes.length + information.length);
  out.set(headerBytes, 0);
  out.set(information, headerBytes.length);
  return out;
}

/** A TNC2 line as text; refuses an information field that is not UTF-8. */
export function tnc2TextOf(bytes: Uint8Array): string {
  const text = decodeUtf8(bytes);
  if (text === undefined) refuse('tnc2-cannot-carry', 'the information field is not UTF-8 text; use encodeTnc2Bytes');
  return text;
}

/**
 * Encodes a packet as the bytes of a TNC2 / APRS-IS line (the information field as sent).
 *
 * @throws AprsEncodeError: `invalid-address` or `invalid-path` for the header given, before the data
 * is looked at; the data's own refusals; then `tnc2-cannot-carry` when a line cannot carry it (the
 * header reads back as another, or the information field holds a CR or LF before its end).
 */
export function encodeTnc2Bytes(p: PacketToEncode): Uint8Array {
  return guarded(() => {
    // An address APRS-IS does not allow comes first; a header the line cannot carry after the data.
    checkHeaderAddresses(p.source, givenDestination(p), p.path ?? []);
    const r = resolve(p);
    checkHeaderAddresses(p.source, r.destination, r.path);
    return tnc2BytesOf(p.source, r.destination, r.path, r.information);
  });
}

/**
 * Encodes a packet as a TNC2 / APRS-IS line of text. User-defined data that is not UTF-8 has no
 * text form (`tnc2-cannot-carry`); use `encodeTnc2Bytes` for that. Throws as `encodeTnc2Bytes` does.
 */
export function encodeTnc2(p: PacketToEncode): string {
  return tnc2TextOf(encodeTnc2Bytes(p));
}

function ax25Address(text: string, last: boolean, flag: boolean): number[] {
  // A frame never carries an empty address: a held packet's empty destination is refused, not written as spaces.
  if (text === '') refuse('ax25-cannot-carry', 'an AX.25 frame cannot carry an empty address');
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

/**
 * An AX.25 UI frame from a header and an information field: the header is judged as given
 * (`invalid-address`, `invalid-path`), the addresses are written (the H bit on every used entry) and
 * read back, and refused `ax25-cannot-carry` if a call, an SSID or the path cannot be carried or they
 * read back as another header (an empty destination included). The information field is written as
 * it stands, a CR or LF in it too, as for `tnc2BytesOf`.
 */
export function ax25Of(source: string, destination: string, path: readonly (string | PathEntry)[], information: Uint8Array): Uint8Array {
  const entries = pathEntries(path);
  checkHeaderAddresses(source, destination, entries, true);
  if (entries.length > 8) refuse('ax25-cannot-carry', 'AX.25 allows at most 8 digipeaters');
  const bytes: number[] = [];
  bytes.push(...ax25Address(destination, false, true));
  bytes.push(...ax25Address(source, entries.length === 0, false));
  entries.forEach((e, i) => bytes.push(...ax25Address(e.address, i === entries.length - 1, e.used)));
  bytes.push(0x03, 0xf0);
  let read: ParsedHeader;
  try {
    read = parseAx25Frame(Uint8Array.from(bytes), ParseOptions.lenient);
  } catch (e) {
    if (e instanceof AprsHeaderError) refuse('ax25-cannot-carry', `the addresses would not read back: ${e.message}`);
    throw e;
  }
  const why = headerDifference(read, source, destination, entries);
  if (why !== undefined) refuse('ax25-cannot-carry', `an AX.25 frame cannot carry this header: ${why}`);
  bytes.push(...information);
  return Uint8Array.from(bytes);
}

/**
 * Encodes a packet as an AX.25 UI frame in KISS form (no flags, no FCS).
 *
 * @throws AprsEncodeError as `encodeTnc2Bytes` does, with `ax25-cannot-carry` last, when a frame cannot
 * carry the header: a call over six characters or in lower case, an SSID over 15, more than 8 path entries.
 */
export function encodeAx25(p: PacketToEncode): Uint8Array {
  return guarded(() => {
    // An address APRS-IS does not allow comes first; a header the frame cannot carry after the data.
    checkHeaderAddresses(p.source, givenDestination(p), p.path ?? []);
    const r = resolve(p);
    return ax25Of(p.source, r.destination, r.path, r.information);
  });
}

/** Wraps an AX.25 frame for a KISS TNC: FEND, a data command on `port`, escaping, FEND. Not an encoder: the frame is passed through as it stands, with no size check. Throws RangeError unless `port` is an integer 0-15. */
export function wrapKiss(frame: Uint8Array, port = 0): Uint8Array {
  if (!Number.isInteger(port) || port < 0 || port > 15) throw new RangeError('a KISS port is 0-15');
  const out: number[] = [0xc0, (port & 0x0f) << 4];
  for (const b of frame) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return Uint8Array.from(out);
}
