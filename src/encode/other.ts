// Encoding everything that is not a position: messages and what is sent in message form, status,
// telemetry, queries, capabilities, and the rest.

import { encodeUtf8Binary } from '../bytes.js';
import { DIRECTED_QUERY_TYPES } from '../decode/message.js';
import { splitNmea } from '../decode/other.js';
import { formatPath, isAprsIsAddress } from '../header.js';
import type {
  Ack,
  AgreloDf,
  Bulletin,
  Capabilities,
  DirectedQuery,
  MaidenheadBeacon,
  Message,
  NmeaSentence,
  NwsBulletin,
  Query,
  RawWeather,
  Reject,
  StatusReport,
  TelemetryBits,
  TelemetryCoefficients,
  TelemetryNames,
  TelemetryReport,
  TelemetryUnits,
  TestData,
  ThirdParty,
  UserDefined,
} from '../types.js';
import { checkSymbol, freeText, isValidTimestamp, numberText, pad, refuse, whole } from './common.js';

const MESSAGE_ID = /^[A-Za-z0-9]{1,5}$/;
const REPLY_ACK = /^[A-Za-z0-9]{0,5}$/;

function addressee(a: string): string {
  if (a.length === 0 || a.length > 9) refuse(`the addressee ${JSON.stringify(a)} is not 1-9 characters`);
  if (!/^[\x21-\x7e]+$/.test(a) || a.includes(':')) refuse('the addressee has characters that cannot appear in one');
  return a.padEnd(9, ' ');
}

function messageId(id: string | undefined, replyAck: string | undefined): string {
  if (id === undefined) {
    if (replyAck !== undefined) refuse('a reply-ack goes with a message ID');
    return '';
  }
  if (!MESSAGE_ID.test(id)) refuse('a message ID is 1-5 letters or digits');
  if (replyAck === undefined) return `{${id}`;
  if (!REPLY_ACK.test(replyAck)) refuse('a reply-ack is 0-5 letters or digits');
  return `{${id}}${replyAck}`;
}

function messageText(text: string, what = 'message text'): string {
  if (text.includes('{')) refuse(`${what} cannot contain {, which starts a message ID`);
  if ([...text].length > 67) refuse(`${what} is over 67 characters`);
  return freeText(text, what);
}

export function encodeMessage(d: Message): string {
  return `:${addressee(d.addressee)}:${messageText(d.text)}${messageId(d.messageId, d.replyAck)}`;
}

export function encodeAck(d: Ack | Reject): string {
  if ((d as { messageId?: string }).messageId !== undefined) refuse('an ack or rej has no message ID of its own');
  const id = d.type === 'ack' ? d.ackedId : d.rejectedId;
  if (!MESSAGE_ID.test(id)) refuse('the acked message ID is 1-5 letters or digits');
  let out = `:${addressee(d.addressee)}:${d.type === 'ack' ? 'ack' : 'rej'}${id}`;
  if (d.replyAck !== undefined) {
    if (!REPLY_ACK.test(d.replyAck)) refuse('a reply-ack is 0-5 letters or digits');
    out += `}${d.replyAck}`;
  }
  return out;
}

export function encodeBulletin(d: Bulletin | NwsBulletin): string {
  if (d.type === 'bulletin') {
    if (!/^BLN[0-9A-Z]/.test(d.addressee)) refuse('a bulletin addressee is BLN then a digit or letter');
    if (/^BLN[A-Z]./.test(d.addressee)) refuse('a group bulletin has a digit after BLN');
    if (d.text.includes('{') || [...d.text].length > 67) refuse('bulletin text is up to 67 characters, without {');
  } else {
    if (!/^NWS[-_]/.test(d.addressee)) refuse('an NWS bulletin addressee starts NWS-');
    if (d.text.includes('{')) refuse('bulletin text cannot contain {');
  }
  return `:${addressee(d.addressee)}:${freeText(d.text, 'bulletin text')}${messageId(d.messageId, undefined)}`;
}

function listItem(item: string, what: string): string {
  if (item.includes(',')) refuse(`a telemetry ${what} cannot contain a comma`);
  return item;
}

export function encodeTelemetryNames(d: TelemetryNames | TelemetryUnits): string {
  const list = d.type === 'telemetry-names' ? d.names : d.units;
  const what = d.type === 'telemetry-names' ? 'name' : 'unit';
  if (list.length === 0) refuse(`telemetry ${what}s need at least one`);
  if (list.length > 13) refuse(`telemetry ${what}s are at most 13 (5 analog, 8 digital)`);
  const body = (d.type === 'telemetry-names' ? 'PARM.' : 'UNIT.') + list.map((n) => listItem(n, what)).join(',');
  if (body.includes('{')) refuse('telemetry metadata cannot contain {');
  return `:${addressee(d.addressee)}:${freeText(body, 'telemetry metadata')}${messageId(d.messageId, undefined)}`;
}

export function encodeTelemetryCoefficients(d: TelemetryCoefficients): string {
  const list = d.coefficients;
  if (list.length === 0 || list.length > 15) refuse('telemetry coefficients are 1-15 numbers (a, b, c for five channels)');
  const texts = list.map((v, i) => {
    const t = d.coefficientsText?.[i];
    return t !== undefined && Number(t) === v ? t : numberText(v);
  });
  return `:${addressee(d.addressee)}:EQNS.${texts.join(',')}${messageId(d.messageId, undefined)}`;
}

export function encodeTelemetryBits(d: TelemetryBits): string {
  if (!/^[01]{8}$/.test(d.bits)) refuse('telemetry bit sense is eight 0/1 characters');
  let body = `BITS.${d.bits}`;
  if (d.project !== undefined && d.project.length > 0) {
    if ([...d.project].length > 23) refuse('a telemetry project title is at most 23 characters');
    if (d.project.includes('{')) refuse('a telemetry project title cannot contain {');
    body += `,${d.project}`;
  }
  return `:${addressee(d.addressee)}:${freeText(body, 'the project title')}${messageId(d.messageId, undefined)}`;
}

export function encodeDirectedQuery(d: DirectedQuery): string {
  if (!/^(?:[A-Z]+|PING\?)$/.test(d.queryType)) refuse('a query type is upper-case letters');
  let out = `:${addressee(d.addressee)}:?${d.queryType}`;
  if (d.target !== undefined) {
    if (!/^[A-Za-z0-9-]{1,9}$/.test(d.target)) refuse('a query target is one callsign');
    // A type the spec defines is followed straight by the target, an APRSH target padded to 9
    // characters; any other type has no fixed length, so its target follows one space.
    if (!DIRECTED_QUERY_TYPES.includes(d.queryType)) out += ` ${d.target}`;
    else out += d.queryType === 'APRSH' ? d.target.padEnd(9, ' ') : d.target;
  }
  return out;
}

export function encodeStatus(d: StatusReport): string {
  let out = '>';
  if (d.timestamp) {
    if (d.timestamp.kind !== 'dhm-zulu') refuse('a status timestamp is day/hour/minute zulu');
    if (!isValidTimestamp(d.timestamp)) refuse('the timestamp is out of range');
    if (d.locator !== undefined) refuse('a status report with a locator has no timestamp');
    const t = d.timestamp;
    out += `${pad(t.day, 2)}${pad(t.hour, 2)}${pad(t.minute, 2)}z`;
  }
  const text = d.text ?? '';
  if (d.locator !== undefined) {
    if (!/^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/.test(d.locator)) refuse('the locator is 4 or 6 characters, upper case');
    if (!d.symbol) refuse('a status locator is followed by a symbol');
    checkSymbol(d.symbol);
    out += d.locator + d.symbol.table + d.symbol.code;
    if (text.length > 0 || d.beam) out += ' ';
  } else if (d.symbol) {
    refuse('a status symbol goes with a locator');
  }
  out += freeText(text, 'status text');
  if (d.beam) {
    if (!/^[0-9A-Z]$/.test(d.beam.headingCode) || !/^[1-9:;<=>?@A-K]$/.test(d.beam.powerCode))
      refuse('beam heading is 0-9 or A-Z, and power 1-9 or :-K');
    out += `^${d.beam.headingCode}${d.beam.powerCode}`;
  }
  return out;
}

export function encodeTelemetryReport(d: TelemetryReport): string {
  if (d.sequence !== 'MIC' && !/^[A-Za-z0-9]+$/.test(d.sequence)) refuse('a telemetry sequence is letters and digits, or MIC');
  if (d.analog.length !== 5) refuse('a telemetry report has five analog values');
  if (d.bits === undefined || !/^[01]{8}$/.test(d.bits)) refuse('a telemetry report has eight 0/1 bits');
  const values = d.analog.map((v, i) => {
    if (v === null) return '';
    const t = d.analogText?.[i];
    if (t !== undefined && t !== null && Number(t) === v) return t;
    // The classic form: three digits, 000-999 (APRS12c ch. 13).
    return Number.isInteger(v) && v >= 0 && v <= 999 ? pad(v, 3) : numberText(v);
  });
  const seq = d.sequence === 'MIC' ? 'MIC' : `${d.sequence},`;
  return `T#${seq}${values.join(',')},${d.bits}${freeText(d.comment ?? '', 'the comment')}`;
}

const RAW_PREFIX: Record<RawWeather['format'], string> = {
  'peet-bros-hash': '#',
  'peet-bros-star': '*',
  'ultimeter-packet': '$ULTW',
  'ultimeter-logging': '!!',
};

export function encodeRawWeather(d: RawWeather): string {
  const data = d.data ?? '';
  if (!/^[\x20-\x7e]*$/.test(data)) refuse('raw weather data is printable ASCII');
  return RAW_PREFIX[d.format] + data;
}

export function encodeNmea(d: NmeaSentence): string {
  const parts = splitNmea(d.sentence);
  if (!parts || parts.rest.length > 0) refuse('not an NMEA 0183 sentence');
  if (!parts.checksumOk) refuse("the NMEA sentence's checksum does not match");
  const comment = d.comment ?? '';
  if (comment.length > 0 && !parts.hasChecksum) refuse('a comment after an NMEA sentence needs the checksum that ends the sentence');
  return `$${d.sentence}${freeText(comment, 'the comment')}`;
}

export function encodeMaidenhead(d: MaidenheadBeacon): string {
  if (!/^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/.test(d.locator)) refuse('the locator is 4 or 6 characters, upper case');
  return `[${d.locator}]${freeText(d.comment ?? '', 'the comment')}`;
}

export function encodeQuery(d: Query): string {
  if (!/^[A-Z]+$/.test(d.queryType)) refuse('a query type is upper-case letters');
  let out = `?${d.queryType}?`;
  if (d.footprint) {
    const f = d.footprint;
    if (!(f.latitude >= -90 && f.latitude <= 90) || !(f.longitude >= -180 && f.longitude <= 180)) refuse('the footprint is out of range');
    // Each value as sent, a leading space or its absence included, when that is the value (vectors
    // rulings, E1); otherwise a positive latitude after a space, as APRS12c's example has it.
    const asSent = (text: string | undefined, v: number): string | undefined =>
      text !== undefined && FOOTPRINT_VALUE.test(text) && Number(text) === v ? text : undefined;
    const lat = asSent(f.latitudeText, f.latitude) ?? (f.latitude < 0 ? numberText(f.latitude) : ` ${numberText(f.latitude)}`);
    const lon = asSent(f.longitudeText, f.longitude) ?? numberText(f.longitude);
    out += `${lat},${lon},${pad(whole(f.radiusMiles, 0, 9999, 'radius'), 4)}`;
  }
  return out;
}

/** A footprint value as a decoder reads it: a number as a telemetry value is, a positive one after at most one space. */
const FOOTPRINT_VALUE = /^(?: ?(?:[0-9]+\.?[0-9]*|\.[0-9]+)|-(?:[0-9]+\.?[0-9]*|\.[0-9]+))$/;

/** A control character: below U+0020, or U+007F. */
const CONTROL_RE = /[\x00-\x1f\x7f]/;

export function encodeCapabilities(d: Capabilities): string {
  if (d.capabilities.length === 0) refuse('capabilities need at least one item');
  // Anything that would not read back the same (vectors interpretations.md, "Station
  // capabilities: items, tokens and values") is refused.
  const items = d.capabilities.map((c) => {
    const token = c[0];
    if (token.length === 0 || /[ ,=]/.test(token) || CONTROL_RE.test(token)) refuse('a capability token is not empty and has no space, control character, comma or =');
    if (c.length === 1) return token;
    const value = c[1]!;
    if (value.includes(',') || CONTROL_RE.test(value) || value.startsWith(' ') || value.endsWith(' '))
      refuse('a capability value has no comma or control character, and does not start or end with a space');
    return `${token}=${value}`;
  });
  return '<' + encodeUtf8Binary(items.join(','));
}

export function encodeUserDefined(d: UserDefined): string {
  if (d.userId.length !== 1 || d.packetType.length !== 1) refuse('a user ID and packet type are one character each');
  const data = d.data ?? '';
  if (/[^\x00-\xff]/.test(data)) refuse('user-defined data is bytes (U+0000-U+00FF)');
  if (/[\r\n]$/.test(data)) refuse('user-defined data cannot end in a line break');
  return `{${d.userId}${d.packetType}${data}`;
}

export function encodeTest(d: TestData): string {
  return `,${freeText(d.data ?? '', 'test data')}`;
}

export function encodeAgrelo(d: AgreloDf): string {
  return `%${pad(whole(d.bearingDegrees, 0, 360, 'bearing'), 3)}/${whole(d.quality, 0, 9, 'quality')}`;
}

/** The third-party header and the encapsulated packet's information field. */
export function encodeThirdParty(d: ThirdParty, innerInfo: string): string {
  const p = d.packet;
  // The source is 1-9 printable ASCII characters other than > and : (APRS12c ch. 17); the
  // destination and path are APRS-IS addresses.
  if (!/^[\x20-\x39\x3b-\x3d\x3f-\x7e]{1,9}$/.test(p.source)) refuse('a third-party source is 1-9 printable ASCII characters other than > and :');
  if (!isAprsIsAddress(p.destination)) refuse('the third-party destination is not a valid address');
  for (const e of p.path) if (!isAprsIsAddress(e.address)) refuse(`the third-party path entry ${JSON.stringify(e.address)} is not a valid address`);
  const header = p.path.length > 0 ? `${p.source}>${p.destination},${formatPath(p.path)}` : `${p.source}>${p.destination}`;
  return `}${header}:${innerInfo}`;
}
