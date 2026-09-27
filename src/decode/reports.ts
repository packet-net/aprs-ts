// Position reports, objects, items, Mic-E reports and positionless weather reports.

import { findMicESuffix } from '../deviceid.js';
import type {
  AprsTimestamp,
  ItemReport,
  MicEMessage,
  MicEReport,
  ObjectReport,
  PositionReport,
  WeatherReport,
} from '../types.js';
import type { DecodeContext } from './context.js';
import {
  applyDao,
  applyLiftedTo,
  base91Value,
  decodeAfterPosition,
  isDigit,
  isSymbolTable,
  liftMicEComment,
  METRES_PER_FOOT,
  parsePosition,
  parsePositionlessWeather,
  positionDecodesAt,
  timestampAt,
  timestampValid,
  type Fields,
  type RawPosition,
} from './positioned.js';

function withTimestamp<T extends object>(fields: T, timestamp: AprsTimestamp | undefined): T {
  return timestamp ? { ...fields, timestamp } : fields;
}

/** `!`, `=`, `/`, `@`: a position report. */
export function decodePositionReport(ctx: DecodeContext, s: string): PositionReport {
  const dti = s[0]!;
  const messaging = dti === '=' || dti === '@';
  let start = 1;
  let timestamp: AprsTimestamp | undefined;
  if (dti === '/' || dti === '@') {
    timestamp = timestampAt(s, 1);
    if (timestamp) {
      if (!timestampValid(timestamp)) ctx.tolerate('invalid-timestamp');
      start = 8;
    } else if (positionDecodesAt(ctx, s, 1)) {
      ctx.tolerate('malformed-timestamp');
      start = 1;
    } else if (positionDecodesAt(ctx, s, 8)) {
      ctx.tolerate('malformed-timestamp');
      start = 8;
    } else {
      ctx.fail('malformed-timestamp');
    }
  }
  const pos = parsePosition(ctx, s, start);
  const fields = decodeAfterPosition(ctx, s, start + pos.length, pos);
  const head: { type: 'position'; timestamp?: AprsTimestamp; messaging?: boolean } = { type: 'position' };
  if (timestamp) head.timestamp = timestamp;
  if (messaging) head.messaging = true;
  return { ...head, ...fields };
}

/** `;`: an object report. */
export function decodeObject(ctx: DecodeContext, s: string): ObjectReport {
  if (s.length < 11) ctx.fail('truncated');
  let marker = 10;
  if (s[10] !== '*' && s[10] !== '_') {
    marker = -1;
    for (let k = 1; k <= 9; k++) {
      if (s[k] === '*' || s[k] === '_') {
        marker = k;
        break;
      }
    }
    if (marker < 0) ctx.fail('invalid-object-name');
    ctx.tolerate('object-name-not-padded');
  }
  const name = s.slice(1, marker).replace(/ +$/, '');
  if (name.length === 0 || !/^[\x20-\x7e]+$/.test(name)) ctx.fail('invalid-object-name');
  const killed = s[marker] === '_';
  let timestamp = timestampAt(s, marker + 1);
  let start: number;
  if (timestamp) {
    if (!timestampValid(timestamp)) ctx.tolerate('invalid-timestamp');
    start = marker + 8;
  } else {
    const seven = s.substr(marker + 1, 7);
    const looksLike = seven.length === 7 && (/^[0-9]{6}/.test(seven) || 'z/h'.includes(seven[6]!));
    if (looksLike && positionDecodesAt(ctx, s, marker + 8)) {
      ctx.tolerate('malformed-timestamp');
      start = marker + 8;
    } else {
      ctx.tolerate('object-without-timestamp');
      start = marker + 1;
    }
    timestamp = undefined;
  }
  const pos = parsePosition(ctx, s, start);
  const fields = decodeAfterPosition(ctx, s, start + pos.length, pos);
  const head: { type: 'object'; name: string; killed?: boolean } = { type: 'object', name };
  if (killed) head.killed = true;
  return withTimestamp({ ...head, ...fields }, timestamp);
}

/** `)`: an item report. */
export function decodeItem(ctx: DecodeContext, s: string): ItemReport {
  let marker = -1;
  for (let k = 4; k < s.length && k <= 10; k++) {
    if (s[k] === '!' || s[k] === '_') {
      marker = k;
      break;
    }
  }
  if (marker < 0) ctx.fail('invalid-item-name');
  const name = s.slice(1, marker);
  if (!/^[\x20-\x7e]{3,9}$/.test(name)) ctx.fail('invalid-item-name');
  const killed = s[marker] === '_';
  const pos = parsePosition(ctx, s, marker + 1);
  const fields = decodeAfterPosition(ctx, s, marker + 1 + pos.length, pos);
  const head: { type: 'item'; name: string; killed?: boolean } = { type: 'item', name };
  if (killed) head.killed = true;
  return { ...head, ...fields };
}

/** `_`: a positionless weather report. */
export function decodePositionlessWeather(ctx: DecodeContext, s: string): WeatherReport {
  ctx.info('obsolete-format');
  const ts = s.substr(1, 8);
  if (!/^[0-9]{8}$/.test(ts)) ctx.fail('invalid-timestamp');
  const timestamp: AprsTimestamp = {
    kind: 'mdhm',
    month: Number(ts.substr(0, 2)),
    day: Number(ts.substr(2, 2)),
    hour: Number(ts.substr(4, 2)),
    minute: Number(ts.substr(6, 2)),
  };
  if (!timestampValid(timestamp)) ctx.tolerate('invalid-timestamp');
  const parsed = parsePositionlessWeather(ctx, s, 9);
  const out: { -readonly [K in keyof WeatherReport]: WeatherReport[K] } = {
    type: 'weather',
    timestamp,
    weather: parsed.weather,
  };
  if (parsed.comment !== undefined && parsed.comment.length > 0) out.comment = parsed.comment;
  return out;
}

// ---- Mic-E (APRS12c ch. 10)

const STANDARD_MESSAGES: readonly MicEMessage[] = [
  'emergency',
  'priority',
  'special',
  'committed',
  'returning',
  'in-service',
  'en-route',
  'off-duty',
];
const CUSTOM_MESSAGES: readonly MicEMessage[] = [
  'emergency',
  'custom6',
  'custom5',
  'custom4',
  'custom3',
  'custom2',
  'custom1',
  'custom0',
];

interface MicEDestination {
  digits: string;
  ambiguity: number;
  message: MicEMessage;
  north: boolean;
  lonOffset: boolean;
  west: boolean;
  ssid: number;
}

function decodeMicEDestination(ctx: DecodeContext, destination: string): MicEDestination {
  const dash = destination.indexOf('-');
  const call = dash >= 0 ? destination.slice(0, dash) : destination;
  const ssid = dash >= 0 ? Number(destination.slice(dash + 1)) : 0;
  if (call.length !== 6) ctx.fail('invalid-mic-e-destination');
  let digits = '';
  const kinds: ('std' | 'custom' | 'zero')[] = [];
  const flags: boolean[] = [];
  for (let k = 0; k < 6; k++) {
    const c = call[k]!;
    if (c >= '0' && c <= '9') {
      digits += c;
      kinds.push('zero');
      flags.push(false);
    } else if (k < 3 && c >= 'A' && c <= 'J') {
      digits += String.fromCharCode(c.charCodeAt(0) - 17);
      kinds.push('custom');
      flags.push(false);
    } else if (k < 3 && c === 'K') {
      digits += ' ';
      kinds.push('custom');
      flags.push(false);
    } else if (c === 'L') {
      digits += ' ';
      kinds.push('zero');
      flags.push(false);
    } else if (c >= 'P' && c <= 'Y') {
      digits += String.fromCharCode(c.charCodeAt(0) - 32);
      kinds.push('std');
      flags.push(true);
    } else if (c === 'Z') {
      digits += ' ';
      kinds.push('std');
      flags.push(true);
    } else {
      ctx.fail('invalid-mic-e-destination');
    }
  }
  // Ambiguity: trailing blanks in the latitude digits (minutes and hundredths only).
  let ambiguity = 0;
  for (let k = 5; k >= 2 && digits[k] === ' '; k--) ambiguity++;
  for (let k = 0; k < 6 - ambiguity; k++) if (!isDigit(digits[k])) ctx.fail('invalid-mic-e-destination');
  const num = (c: string): number => (c === ' ' ? 0 : c.charCodeAt(0) - 48);
  const degrees = num(digits[0]!) * 10 + num(digits[1]!);
  const minutes = num(digits[2]!) * 10 + num(digits[3]!) + (num(digits[4]!) * 10 + num(digits[5]!)) / 100;
  if (minutes >= 60 || degrees > 90 || (degrees === 90 && minutes > 0)) ctx.fail('invalid-mic-e-destination');
  const bits = kinds.slice(0, 3);
  const hasStd = bits.includes('std');
  const hasCustom = bits.includes('custom');
  const index = (bits[0] !== 'zero' ? 4 : 0) + (bits[1] !== 'zero' ? 2 : 0) + (bits[2] !== 'zero' ? 1 : 0);
  const message: MicEMessage =
    hasStd && hasCustom ? 'unknown' : hasCustom ? CUSTOM_MESSAGES[index]! : STANDARD_MESSAGES[index]!;
  return { digits, ambiguity, message, north: flags[3]!, lonOffset: flags[4]!, west: flags[5]!, ssid };
}

function micEMinutes(tens: number, units: number, hundredths: number, ambiguity: number): number {
  switch (ambiguity) {
    case 0:
      return tens * 10 + units + hundredths / 100;
    case 1:
      return tens * 10 + units + Math.floor(hundredths / 10) / 10 + 0.05;
    case 2:
      return tens * 10 + units + 0.5;
    case 3:
      return tens * 10 + 5;
    default:
      return 30;
  }
}

const TYPE_CODES = '`\'>] ';

/** `` ` ``, `'`, 0x1c, 0x1d: a Mic-E report. */
export function decodeMicE(ctx: DecodeContext, s: string): MicEReport {
  const dest = decodeMicEDestination(ctx, ctx.destination);
  if (s.length < 9) ctx.fail('invalid-mic-e-information');
  const b = (k: number): number => s.charCodeAt(k);
  if (b(1) < 38 || b(1) > 127 || b(2) < 38 || b(2) > 97 || b(3) < 28 || b(3) > 127) ctx.fail('invalid-mic-e-information');
  if (b(4) < 28 || b(4) > 127 || b(5) < 28 || b(5) > 127 || b(6) < 28 || b(6) > 127) ctx.fail('invalid-mic-e-information');
  // Latitude
  const d = dest.digits;
  const num = (c: string): number => (c === ' ' ? 0 : c.charCodeAt(0) - 48);
  const latDegrees = num(d[0]!) * 10 + num(d[1]!);
  const latMinutes = micEMinutes(num(d[2]!), num(d[3]!), num(d[4]!) * 10 + num(d[5]!), dest.ambiguity);
  // Longitude
  let lonDegrees = b(1) - 28;
  if (dest.lonOffset) lonDegrees += 100;
  if (lonDegrees >= 180 && lonDegrees <= 189) lonDegrees -= 80;
  else if (lonDegrees >= 190 && lonDegrees <= 199) lonDegrees -= 190;
  let lonMin = b(2) - 28;
  if (lonMin >= 60) lonMin -= 60;
  const lonHundredths = b(3) - 28;
  if (lonDegrees > 179) ctx.fail('invalid-mic-e-information');
  const lonMinutes = micEMinutes(Math.floor(lonMin / 10), lonMin % 10, lonHundredths, dest.ambiguity);
  // Speed and course
  const sp = b(4) - 28;
  const dc = b(5) - 28;
  const se = b(6) - 28;
  let speed = sp * 10 + Math.floor(dc / 10);
  if (speed >= 800) speed -= 800;
  let course = (dc % 10) * 100 + se;
  if (course >= 400) course -= 400;
  let courseOk = true;
  if (course > 360) {
    ctx.tolerate('out-of-range-value');
    courseOk = false;
  }
  const code = s[7]!;
  const table = s[8]!;
  if (!isSymbolTable(table)) ctx.fail('invalid-symbol-table');
  const codeValue = code.charCodeAt(0);
  if (codeValue < 0x21 || codeValue > 0x7e) ctx.fail('invalid-symbol-code');
  const latitude = (dest.north ? 1 : -1) * (latDegrees + latMinutes / 60);
  const longitude = (dest.west ? -1 : 1) * (lonDegrees + lonMinutes / 60);
  const pos: RawPosition = {
    latDegrees,
    latMinutes,
    latSouth: !dest.north,
    lonDegrees,
    lonMinutes,
    lonWest: dest.west,
    latitude,
    longitude,
    ambiguity: dest.ambiguity,
    symbol: { table, code },
    compressed: false,
    csBlank: true,
    length: 9,
  };
  const f: Fields = { latitude: pos.latitude, longitude: pos.longitude, symbol: pos.symbol };
  if (pos.ambiguity > 0) f.ambiguity = pos.ambiguity;
  if (courseOk && course !== 0) f.courseDegrees = course;
  f.speedKnots = speed;

  // Status text
  let text = s.slice(9);
  if (text.includes('\xff')) {
    ctx.tolerate('kenwood-ff-padding');
    text = text.replace(/\xff/g, '');
  }
  // Rev 0 binary telemetry, looked for once the 0xFF padding is gone (vectors interpretations.md).
  let legacyTelemetry: number[] | undefined;
  if (text.length >= 6 && text[0] === '\x1d') {
    ctx.info('obsolete-format');
    legacyTelemetry = [...text.slice(1, 6)].map((c) => c.charCodeAt(0));
    text = text.slice(6);
  }
  let typeCode: string | undefined;
  if (text.length > 0 && TYPE_CODES.includes(text[0]!)) {
    typeCode = text[0]!;
    text = text.slice(1);
  } else if (text.length > 0) {
    ctx.info('mic-e-missing-device-type');
  }
  let deviceSuffix: string | undefined;
  if (typeCode !== undefined) {
    deviceSuffix = findMicESuffix(typeCode, text);
    if (deviceSuffix !== undefined) text = text.slice(0, text.length - deviceSuffix.length);
  }
  let altitudeFeet: number | undefined;
  const altFirst = /^([!-{]{3})\}/.exec(text);
  if (altFirst) {
    altitudeFeet = (base91Value(altFirst[1]!) - 10000) / METRES_PER_FOOT;
    text = text.slice(4);
  } else {
    const later = /([!-{]{3})\}/.exec(text);
    if (later && ctx.allows('mic-e-altitude-not-first')) {
      altitudeFeet = (base91Value(later[1]!) - 10000) / METRES_PER_FOOT;
      text = text.slice(0, later.index) + text.slice(later.index + 4);
    }
  }
  if (altitudeFeet !== undefined) f.altitudeFeet = altitudeFeet;
  let locator: string | undefined;
  const loc = /^([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\/G/.exec(text);
  if (loc) {
    locator = loc[1]!.toUpperCase();
    text = text.slice(loc[0].length);
    if (text.length > 0) {
      if (text[0] === ' ') text = text.slice(1);
      else ctx.tolerate('missing-space-after-locator');
    }
  }
  const { lifted } = liftMicEComment(ctx, text, pos.symbol);
  applyLiftedTo(ctx, f, lifted);
  applyDao(ctx, f, pos, lifted.dao);

  const dti = s[0]!;
  const head: {
    type: 'mic-e';
    micEMessage: MicEMessage;
    oldData?: boolean;
    typeCode?: string;
    deviceSuffix?: string;
    locator?: string;
    legacyTelemetry?: readonly number[];
    destinationSsid?: number;
  } = { type: 'mic-e', micEMessage: dest.message };
  if (dti === "'" || dti === '\x1d') head.oldData = true;
  if (typeCode !== undefined) head.typeCode = typeCode;
  if (deviceSuffix !== undefined) head.deviceSuffix = deviceSuffix;
  if (locator !== undefined) head.locator = locator;
  if (legacyTelemetry !== undefined) head.legacyTelemetry = legacyTelemetry;
  if (dest.ssid !== 0) head.destinationSsid = dest.ssid;
  return { ...head, ...f };
}
