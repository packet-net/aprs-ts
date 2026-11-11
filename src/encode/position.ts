// Encoding positions, objects, items and Mic-E reports, with their data extensions, weather and
// comment elements, in the canonical order: extension, frequency, signpost or corridor braces,
// altitude, comment, base-91 telemetry, !DAO! (vectors README, "Encoding"). Mic-E status text
// keeps its own order: extension, altitude, frequency, comment, telemetry, !DAO!, device suffix.

import { AREA_COLORS, AREA_SHAPES, KNOTS_TO_MPH, METRES_PER_FOOT, MICROWAVE_BASE } from '../decode/positioned.js';
import type {
  AprsSymbol,
  CommentTelemetry,
  CompressionType,
  ItemReport,
  MicEMessage,
  MicEReport,
  ObjectReport,
  PositionedFields,
  PositionReport,
  VoiceFrequency,
  Weather,
  WeatherReport,
} from '../types.js';
import { identifyMicE } from '../deviceid.js';
import { base91, checkSymbol, freeText, isValidTimestamp, nearest, pad, flag, numberFault, refuse, timestamp7, whole } from './common.js';

const EPS = 1e-9;
const CUT_TOLERANCE = 1e-6;

/** Negative, or negative zero: a zero coordinate keeps its hemisphere as the sign of zero. */
export function isNegative(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

// ---- coordinates

interface Digits {
  degrees: number;
  /** Hundredths of a minute. */
  hundredths: number;
  /** The `!DAO!` digit below the hundredths: 0-9 in thousandths, 0-90 in ninety-firsts. */
  extra: number;
}

/**
 * How a coordinate's digits are found: rounded to the nearest hundredth of a minute, truncated to
 * one (ambiguity, which reports the centre of the box the digits left give), or rounded to the
 * nearest step of a `!DAO!` of that precision (thousandths, or ninety-firsts of a hundredth, vectors
 * interpretations.md), whose last digit is the `!DAO!` one.
 */
type DigitsMode = 'round' | 'truncate' | 'thousandths' | 'base91';

/** Degrees and hundredths of a minute, and the `!DAO!` digit below them. */
function digitsOf(value: number, mode: DigitsMode, ambiguity = 0): Digits {
  const abs = Math.abs(value);
  // The ambiguity cut takes F2's tolerance: a value within 1e-6 of the box edge above it, in the
  // box's units, is on that edge (vectors rulings, G2).
  let degrees = Math.floor(abs + (mode === 'truncate' && ambiguity >= 4 ? CUT_TOLERANCE : EPS));
  const minutes = Math.max(0, (abs - degrees) * 60);
  let hundredths: number;
  let extra = 0;
  switch (mode) {
    case 'round':
      hundredths = nearest(minutes * 100);
      break;
    case 'truncate': {
      // Hundredths of a minute in each box: a tenth, a minute, ten minutes, or a whole degree.
      const box = ambiguity >= 4 ? 6000 : ambiguity === 3 ? 1000 : ambiguity === 2 ? 100 : ambiguity === 1 ? 10 : 1;
      hundredths = ambiguity >= 4 ? 0 : Math.floor((minutes * 100) / box + (ambiguity > 0 ? CUT_TOLERANCE : EPS)) * box;
      break;
    }
    case 'thousandths': {
      const steps = nearest(minutes * 1000);
      hundredths = Math.floor(steps / 10);
      extra = steps % 10;
      break;
    }
    case 'base91': {
      const steps = nearest(minutes * 9100);
      hundredths = Math.floor(steps / 91);
      extra = steps % 91;
      break;
    }
  }
  if (hundredths >= 6000) {
    degrees += 1;
    hundredths -= 6000;
  }
  return { degrees, hundredths, extra };
}

/** How a position's digits are found, given its ambiguity and `!DAO!`. */
function digitsMode(f: PositionedFields): DigitsMode {
  if ((f.ambiguity ?? 0) > 0) return 'truncate';
  const precision = f.dao?.precision;
  return precision === 'thousandths' || precision === 'base91' ? precision : 'round';
}

function blank(text: string, positions: readonly number[], ambiguity: number): string {
  const chars = text.split('');
  for (let k = 0; k < ambiguity; k++) chars[positions[positions.length - 1 - k]!] = ' ';
  return chars.join('');
}

/** `ddmm.hhN/dddmm.hhW$`, with the `!DAO!` digits. */
function uncompressedPosition(f: PositionedFields): { text: string; latExtra: number; lonExtra: number } {
  if (!(f.latitude >= -90 && f.latitude <= 90)) flag(numberFault(f.latitude), `latitude ${f.latitude} is out of range`);
  if (!(f.longitude >= -180 && f.longitude <= 180)) flag(numberFault(f.longitude), `longitude ${f.longitude} is out of range`);
  const ambiguity = f.ambiguity ?? 0;
  if (!Number.isInteger(ambiguity) || ambiguity < 0 || ambiguity > 4) flag(numberFault(ambiguity), 'ambiguity is 0-4 digits');
  checkSymbol(f.symbol);
  const mode = digitsMode(f);
  const lat = digitsOf(f.latitude, mode, ambiguity);
  const lon = digitsOf(f.longitude, mode, ambiguity);
  if (lat.degrees > 90 || (lat.degrees === 90 && lat.hundredths > 0)) flag('value-out-of-range', 'latitude is out of range');
  if (lon.degrees > 180 || (lon.degrees === 180 && lon.hundredths > 0)) flag('value-out-of-range', 'longitude is out of range');
  // An ambiguous position reads back as the middle of its square, which is past a pole or 180 degrees there.
  if (ambiguity > 0 && lat.degrees === 90) flag('value-has-no-form', 'an ambiguous position at the pole has no form');
  if (ambiguity > 0 && lon.degrees === 180) flag('value-has-no-form', 'an ambiguous position at 180 degrees has no form');
  const latMin = pad(Math.floor(lat.hundredths / 100), 2) + '.' + pad(lat.hundredths % 100, 2);
  const lonMin = pad(Math.floor(lon.hundredths / 100), 2) + '.' + pad(lon.hundredths % 100, 2);
  const latText = blank(pad(lat.degrees, 2) + latMin, [2, 3, 5, 6], ambiguity) + (isNegative(f.latitude) ? 'S' : 'N');
  const lonText = blank(pad(lon.degrees, 3) + lonMin, [3, 4, 6, 7], ambiguity) + (isNegative(f.longitude) ? 'W' : 'E');
  return {
    text: latText + f.symbol.table + lonText + f.symbol.code,
    latExtra: lat.extra,
    lonExtra: lon.extra,
  };
}

const SOURCES = ['other', 'gll', 'gga', 'rmc'];
const ORIGINS = ['compressed', 'tnc-beacon-text', 'software', 'reserved3', 'kpc3', 'pico', 'other-tracker', 'digipeater-conversion'];

export const DEFAULT_COMPRESSION: CompressionType = { fix: 'current', source: 'other', origin: 'software' };

function typeByte(c: CompressionType): string {
  const source = SOURCES.indexOf(c.source);
  const origin = ORIGINS.indexOf(c.origin);
  if (source < 0 || origin < 0 || (c.fix !== 'old' && c.fix !== 'current')) flag('invalid-code', 'the compression type is not one APRS defines');
  return String.fromCharCode(((c.fix === 'current' ? 1 : 0) << 5) + (source << 3) + origin + 33);
}

/**
 * The compressed position; `cs` is the two cs bytes or `undefined` for none. Also gives the
 * `!DAO!` digits for it: a decoder does not apply them, so they are the ones a `!DAO!` of that
 * precision gives the position the bytes report, written uncompressed (vectors rulings, E2).
 */
function compressedPosition(
  f: PositionedFields,
  cs: string | undefined,
  compression: CompressionType | undefined,
): { text: string; latExtra: number; lonExtra: number } {
  if (!(f.latitude >= -90 && f.latitude <= 90)) flag(numberFault(f.latitude), `latitude ${f.latitude} is out of range`);
  if (!(f.longitude >= -180 && f.longitude <= 180)) flag(numberFault(f.longitude), `longitude ${f.longitude} is out of range`);
  if ((f.ambiguity ?? 0) !== 0) flag('field-not-allowed', 'a compressed position cannot be ambiguous');
  checkSymbol(f.symbol);
  let table = f.symbol.table;
  if (table >= '0' && table <= '9') table = String.fromCharCode(table.charCodeAt(0) + 49); // 0-9 -> a-j
  const max = 91 ** 4 - 1;
  const y = Math.min(max, Math.max(0, nearest(380926 * (90 - f.latitude))));
  const x = Math.min(max, Math.max(0, nearest(190463 * (180 + f.longitude))));
  const tail = cs === undefined ? ' sT' : cs + typeByte(compression ?? DEFAULT_COMPRESSION);
  const mode = digitsMode(f);
  return {
    text: table + base91(y, 4) + base91(x, 4) + f.symbol.code + tail,
    latExtra: digitsOf(90 - y / 380926, mode).extra,
    lonExtra: digitsOf(x / 190463 - 180, mode).extra,
  };
}

/**
 * A GGA altitude in the cs bytes: 1.002^cs feet, so the nearest value they hold (1 foot for 0 feet
 * or below), and whether that is exact. When it is not, a `/A=` altitude carries it and wins.
 */
function ggaAltitude(feet: number): { cs: string; exact: boolean } {
  if (!Number.isFinite(feet)) flag('not-a-number', 'altitude is not a number');
  const v = feet <= 1 ? 0 : nearest(Math.log(feet) / Math.log(1.002));
  if (v > 91 * 91 - 1) flag('value-out-of-range', 'altitude is too high for the compressed format');
  const cs = String.fromCharCode(Math.floor(v / 91) + 33) + String.fromCharCode((v % 91) + 33);
  return { cs, exact: Math.abs(Math.pow(1.002, v) - feet) <= 1e-9 * Math.abs(feet) };
}

/**
 * A course or wind direction in the cs bytes: 4 degree steps, rounded to the nearest (halves away
 * from zero), and one that rounds to 360 is c = 0, north (vectors rulings, E9).
 */
function compressedDirection(degrees: number): string {
  return String.fromCharCode((nearest(degrees / 4) % 90) + 33);
}

/**
 * A speed in knots in the cs bytes: 1.08^s - 1, the nearest s for any whole s, refused when that
 * s is outside the byte (0-90; 90 is `{`), so -0.03 knots is 0 and -0.3 is refused (vectors
 * rulings, G3).
 */
function compressedSpeed(knots: number, what: string): string {
  if (!(knots > -1)) flag(numberFault(knots), `${what} has no compressed form`);
  const s = nearest(Math.log(knots + 1) / Math.log(1.08));
  if (s < 0) flag('value-out-of-range', `${what} is negative`);
  if (s > 90) flag('value-out-of-range', `${what} is too high for the compressed format`);
  return String.fromCharCode(s + 33);
}

/**
 * A range in the cs bytes: `{` and 2 x 1.08^s miles, the nearest s for any whole s, refused when
 * that s is below 0, so 1.95 miles is 2 and 1.9 is refused (vectors rulings, G3).
 */
function compressedRange(miles: number): string {
  if (!(miles > 0)) flag(numberFault(miles), 'a compressed range is at least 2 miles');
  const s = nearest(Math.log(miles / 2) / Math.log(1.08));
  if (s < 0) flag('value-out-of-range', 'a compressed range is at least 2 miles');
  if (s > 90) flag('value-out-of-range', 'range is out of range for the compressed format');
  return '{' + String.fromCharCode(s + 33);
}

// ---- data extensions and comment elements

function courseSpeed(course: number | undefined, speed: number | undefined, what = 'course'): string {
  const c = course === undefined ? '...' : pad(whole(course, 0, 360, what), 3);
  const s = speed === undefined ? '...' : pad(whole(speed, 0, 999, 'speed'), 3);
  return `${c}/${s}`;
}

function heightChar(h: number): string {
  return String.fromCharCode(whole(h, 0, 78, 'height code') + 48);
}

function rateChar(r: number): string {
  const v = whole(r, 1, 35, 'beacons per hour');
  return v <= 9 ? String(v) : String.fromCharCode(55 + v);
}

function altitudeText(given: number): string {
  if (!Number.isFinite(given)) flag('not-a-number', 'altitude is not a number');
  // Whole feet, the nearest (vectors rulings, F2).
  const feet = nearest(given);
  if (feet < 0) {
    if (feet < -99999) flag('value-out-of-range', 'altitude is out of range');
    return `/A=-${pad(-feet, 5)}`;
  }
  if (feet > 999999) flag('value-out-of-range', 'altitude is out of range');
  return `/A=${pad(feet, 6)}`;
}

export function frequencyText(f: VoiceFrequency): string {
  const mhz = f.mhz;
  if (!(mhz >= 0)) flag(numberFault(mhz), 'the frequency is negative');
  let whole3: string;
  let fraction: string;
  const resolution = f.tenKhzResolution ? 100 : 1000;
  const scaled = nearest(mhz * resolution);
  const intPart = Math.floor(scaled / resolution);
  const fracPart = scaled % resolution;
  fraction = pad(fracPart, f.tenKhzResolution ? 2 : 3);
  if (intPart < 1000) {
    whole3 = pad(intPart, 3);
  } else {
    const letter = Object.entries(MICROWAVE_BASE).find(([, base]) => intPart >= base && intPart < base + 100);
    if (!letter) flag('value-has-no-form', `${mhz} MHz has no APRS frequency form`);
    whole3 = letter ? letter[0] + pad(intPart - letter[1], 2) : '';
  }
  let out = f.tenKhzResolution ? `${whole3}.${fraction} MHz` : `${whole3}.${fraction}MHz`;
  if (f.tone !== undefined) {
    const narrow = f.narrow === true;
    switch (f.tone) {
      case 'off':
        out += narrow ? ' toff' : ' Toff';
        break;
      case 'tone-burst':
        out += narrow ? ' l750' : ' 1750';
        break;
      default: {
        const letter = f.tone === 'tone' ? 'T' : f.tone === 'ctcss' ? 'C' : f.tone === 'dcs' ? 'D' : refuse('invalid-code', 'unknown tone type');
        if (f.toneValue === undefined) flag('missing-field', 'a tone needs its value');
        else out += ' ' + (narrow ? letter.toLowerCase() : letter) + pad(whole(f.toneValue, 0, 999, 'tone'), 3);
      }
    }
  } else if (f.narrow) {
    flag('missing-field', 'narrow modulation is written with the tone');
  }
  if (f.offsetKhz !== undefined) {
    if (f.offsetKhz % 10 !== 0) flag('value-has-no-form', 'the offset is in tens of kHz');
    const v = whole(Math.abs(f.offsetKhz) / 10, 0, 999, 'offset');
    out += ` ${f.offsetKhz < 0 ? '-' : '+'}${pad(v, 3)}`;
  }
  if (f.range !== undefined) {
    out += ` R${pad(whole(f.range, 0, 999, 'range'), 2)}${f.rangeKm ? 'k' : 'm'}`;
  } else if (f.rangeKm) {
    flag('missing-field', 'range in km needs a range');
  }
  return out;
}

export function telemetryText(t: CommentTelemetry): string {
  if (t.analog.length < 1 || t.analog.length > 5) flag('too-long', 'comment telemetry has 1-5 analog values');
  if (t.digital !== undefined && t.analog.length !== 5) flag('malformed', 'comment telemetry bits come after all five analog values');
  const v = (n: number, what: string): string => base91(whole(n, 0, 8280, what), 2);
  let out = '|' + v(t.sequence, 'telemetry sequence');
  for (const a of t.analog) out += v(a, 'telemetry value');
  // Eight binary channels; bits 9-13 are reserved.
  if (t.digital !== undefined) out += base91(whole(t.digital, 0, 255, 'telemetry bits'), 2);
  return out + '|';
}

/**
 * The `!DAO!`: its datum, and digits `latExtra` and `lonExtra` (from `digitsOf`), or zeros when
 * `applied` is false (an ambiguous position, whose digits say nothing finer).
 */
function daoText(f: PositionedFields, latExtra: number, lonExtra: number, applied: boolean): string {
  const dao = f.dao!;
  const datum = dao.datum;
  if (!applied) flag('field-not-allowed', 'a !DAO! adds precision to a position that is ambiguous');
  if (/^[0-9]$/.test(datum)) {
    // A local datum digit has no case to give a precision, so it only goes with spaces.
    if (dao.precision !== 'none') flag('field-not-allowed', 'a !DAO! datum digit carries no added precision');
    return `!${datum}  !`;
  }
  if (!/^[A-Za-z]$/.test(datum)) flag('invalid-code', 'the !DAO! datum is a letter or a digit');
  switch (dao.precision) {
    case 'none':
      return `!${datum.toUpperCase()}  !`;
    case 'thousandths':
      if (!applied) return `!${datum.toUpperCase()}00!`;
      return `!${datum.toUpperCase()}${latExtra}${lonExtra}!`;
    case 'base91':
      if (!applied) return `!${datum.toLowerCase()}!!!`;
      return `!${datum.toLowerCase()}${String.fromCharCode(latExtra + 33)}${String.fromCharCode(lonExtra + 33)}!`;
  }
}

// ---- weather

function weatherValue(v: number | undefined, width: number, min: number, max: number, what: string): string {
  if (v === undefined) return '.'.repeat(width);
  const n = whole(v, min, max, what);
  if (n < 0) return '-' + pad(-n, width - 1);
  return pad(n, width);
}

/**
 * Snowfall in its three characters (vectors rulings, F3): rounded to hundredths if that leaves it
 * under 1, else to tenths if that leaves it under 10, else to a whole number; then a whole number
 * is three digits (`002`, 0.995 as `001`), one under 1 is `.` and two digits (`.50`), any other a
 * digit, `.` and a digit (`2.5`). One that rounds past 999 is refused.
 */
function snowfallText(inches: number): string {
  if (!Number.isFinite(inches)) flag('not-a-number', 'snowfall is not a number of inches');
  const hundredths = nearest(inches * 100);
  if (hundredths < 0) flag('value-out-of-range', 'snowfall is negative');
  if (hundredths < 100) return hundredths % 100 === 0 ? '000' : '.' + pad(hundredths, 2);
  const tenths = nearest(inches * 10);
  if (tenths < 100) return tenths % 10 === 0 ? pad(tenths / 10, 3) : `${Math.floor(tenths / 10)}.${tenths % 10}`;
  return pad(whole(inches, 0, 999, 'snowfall'), 3);
}

/** Weather fields after the wind: gust, temperature, rain, humidity, pressure, and on. */
function weatherFields(w: Weather, mandatory: boolean): string {
  let out = '';
  if (mandatory || w.windGustMph !== undefined) out += 'g' + weatherValue(w.windGustMph, 3, 0, 999, 'gust');
  if (mandatory || w.temperatureF !== undefined) out += 't' + weatherValue(w.temperatureF, 3, -99, 999, 'temperature');
  if (w.rain1hIn !== undefined) out += 'r' + weatherValue(w.rain1hIn * 100, 3, 0, 999, 'rain in the last hour');
  if (w.rain24hIn !== undefined) out += 'p' + weatherValue(w.rain24hIn * 100, 3, 0, 999, 'rain in the last 24 hours');
  if (w.rainMidnightIn !== undefined) out += 'P' + weatherValue(w.rainMidnightIn * 100, 3, 0, 999, 'rain since midnight');
  if (w.humidityPercent !== undefined) {
    const h = whole(w.humidityPercent, 1, 100, 'humidity', 'value-out-of-range', 0);
    out += 'h' + (h === 100 ? '00' : pad(h, 2));
  }
  if (w.pressureMbar !== undefined) out += 'b' + weatherValue(w.pressureMbar * 10, 5, 0, 99999, 'pressure');
  if (w.luminosityWM2 !== undefined) {
    const l = whole(w.luminosityWM2, 0, 1999, 'luminosity');
    out += l < 1000 ? 'L' + pad(l, 3) : 'l' + pad(l - 1000, 3);
  }
  if (w.snow24hIn !== undefined) out += 's' + snowfallText(w.snow24hIn);
  if (w.rainRaw !== undefined) out += '#' + pad(whole(w.rainRaw, 0, 999, 'raw rain counter'), 3);
  for (const e of w.extra ?? []) {
    if (!/^[A-Za-z]$/.test(e.letter) || 'csgtrpPhbLl'.includes(e.letter)) flag('invalid-character', `${e.letter} is not an extra weather field letter`);
    if (!/^[0-9.-]{2,}$/.test(e.value) || !/[0-9]$/.test(e.value)) flag('invalid-character', 'an extra weather field is digits, dots or -, ending in a digit');
    out += e.letter + e.value;
  }
  if (w.software !== undefined || w.unit !== undefined) {
    if (w.software === undefined || !/^[A-Za-z]$/.test(w.software)) flag('text-reads-as-field', 'the weather software type is one letter');
    if (w.unit === undefined || !/^[A-Za-z0-9_-]{2,4}$/.test(w.unit) || /^[0-9]+$/.test(w.unit))
      flag('text-reads-as-field', 'the weather unit is 2-4 letters, digits, - or _');
    out += (w.software ?? '') + (w.unit ?? '');
  }
  return out;
}

/** A positionless weather report (`_`). */
export function encodeWeatherReport(d: WeatherReport): string {
  if (!d.timestamp || d.timestamp.kind !== 'mdhm') flag('invalid-timestamp', 'a positionless weather report has a month/day/hour/minute timestamp');
  else if (!isValidTimestamp(d.timestamp)) flag('invalid-timestamp', 'the timestamp is out of range');
  if (d.comment !== undefined && d.comment.length > 0) flag('field-not-allowed', 'a weather report has no comment');
  const t = d.timestamp?.kind === 'mdhm' ? d.timestamp : { kind: 'mdhm', month: 0, day: 0, hour: 0, minute: 0 };
  const w = d.weather;
  const wind = 'c' + weatherValue(w.windDirectionDegrees, 3, 0, 360, 'wind direction') + 's' + weatherValue(w.windSpeedMph, 3, 0, 999, 'wind speed');
  return `_${pad(t.month, 2)}${pad(t.day, 2)}${pad(t.hour, 2)}${pad(t.minute, 2)}${wind}${weatherFields(w, true)}`;
}

// ---- the positioned body

interface Body {
  /** Everything after the DTI (and timestamp / name): position, extension, comment... */
  text: string;
  /** The compression type written, if any (the round-trip check expects it back). */
  compression?: CompressionType;
}

function hasExtension(f: PositionedFields): string[] {
  const found: string[] = [];
  if (f.phg) found.push('PHG');
  if (f.rangeMiles !== undefined) found.push('range');
  if (f.dfs) found.push('DFS');
  if (f.area) found.push('area');
  return found;
}

/**
 * How the comment is joined on: `plain` (after a space when it follows a frequency), `joined`
 * (straight after a frequency, with no space), `delimited` (after a `/`) or `spaced` (after a
 * space), for when it would otherwise read as something else: a space keeps a Mic-E comment from
 * joining a PHG's digits into an altitude, where a `/` would not (vectors README, Encoding).
 */
export type CommentMode = 'plain' | 'joined' | 'delimited' | 'spaced';

/** Encodes a position and what follows it. */
function positionedBody(f: PositionedFields, mode: CommentMode): Body {
  const isWeather = f.symbol.code === '_';
  if (f.weather && !isWeather) flag('symbol-mismatch', 'weather data needs the weather station symbol (_)');
  if (isWeather && !f.weather) flag('symbol-mismatch', 'the weather station symbol (_) needs weather data');
  // Weather data is a weather report whatever the symbol, so its rules apply too.
  if (f.weather) return weatherBody(f);
  const exts = hasExtension(f);
  // DF and storm data extend a course/speed, so they count as that extension (vectors rulings, F7).
  const hasCourse = f.courseDegrees !== undefined || f.speedKnots !== undefined || (!f.compressed && (f.dfBearing !== undefined || f.storm !== undefined));
  // A compressed report's course/speed and range live in the cs bytes, not the 7-byte extension.
  if (f.compressed) {
    if (hasCourse && f.rangeMiles !== undefined) flag('extension-conflict', 'course/speed and a range both want the cs bytes');
  } else if (exts.length + (hasCourse ? 1 : 0) > 1) flag('extension-conflict', `only one data extension can follow the symbol (${[hasCourse ? 'course/speed' : '', ...exts].filter(Boolean).join(', ')})`);
  if (!f.compressed && f.dfBearing && f.storm) flag('extension-conflict', 'DF and storm data both extend the course/speed');
  if (!f.compressed && hasCourse && f.area === undefined && f.symbol.table === '\\' && f.symbol.code === 'l') flag('symbol-mismatch', 'course/speed on the area symbol (\\l) would read back as an area');
  if (f.dfBearing && !(f.symbol.table === '/' && f.symbol.code === '\\')) flag('symbol-mismatch', 'a DF bearing needs the DF symbol (/\\)');
  if (f.storm && !(f.symbol.code === '@' && (f.symbol.table === '/' || f.symbol.table === '\\'))) flag('symbol-mismatch', 'storm data needs a hurricane symbol (/@ or \\@)');
  if (f.signpost !== undefined && !(f.symbol.table === '\\' && f.symbol.code === 'm')) flag('symbol-mismatch', 'a signpost needs the signpost symbol (\\m)');
  if (f.area && !(f.symbol.table === '\\' && f.symbol.code === 'l')) flag('symbol-mismatch', 'an area object needs the area symbol (\\l)');

  let out = '';
  let compression: CompressionType | undefined;
  let altitudeInCs = false;
  let latExtra = 0;
  let lonExtra = 0;
  let daoApplied = false;
  if (f.compressed) {
    if (f.phg || f.dfs || f.area || f.dfBearing || f.storm) flag('field-not-allowed', 'a compressed report carries only course/speed, range or altitude');
    let cs: string | undefined;
    compression = f.compression;
    if (hasCourse) {
      // The cs bytes hold both, so one alone would add a value the data does not have; a course of
      // 0 (after rounding) would read back as 360 (vectors rulings, F1, F5).
      if (f.courseDegrees === undefined) flag('missing-field', 'a compressed course/speed needs a course');
      if (f.speedKnots === undefined) flag('missing-field', 'a compressed course/speed needs a speed');
      if (f.rangeMiles !== undefined) compressedRange(f.rangeMiles);
      const courseDegrees = f.courseDegrees ?? 0;
      const speedKnots = f.speedKnots ?? 0;
      if (compression?.source === 'gga') flag('extension-conflict', 'a GGA compression type means the cs bytes hold altitude');
      if (f.courseDegrees !== undefined) whole(courseDegrees, 1, 360, 'course', 'value-out-of-range', 0);
      cs = compressedDirection(courseDegrees) + compressedSpeed(speedKnots, 'speed');
      compression = compression ?? DEFAULT_COMPRESSION;
    } else if (f.rangeMiles !== undefined) {
      if (compression?.source === 'gga') flag('extension-conflict', 'a GGA compression type means the cs bytes hold altitude');
      cs = compressedRange(f.rangeMiles);
      compression = compression ?? DEFAULT_COMPRESSION;
    } else if (f.altitudeFeet !== undefined && compression?.source === 'gga') {
      const alt = ggaAltitude(f.altitudeFeet);
      cs = alt.cs;
      altitudeInCs = alt.exact;
    } else if (compression !== undefined) {
      flag('missing-field', 'a compression type needs cs data (course/speed, range or altitude)');
    }
    const pos = compressedPosition(f, cs, compression);
    out += pos.text;
    latExtra = pos.latExtra;
    lonExtra = pos.lonExtra;
    daoApplied = true;
  } else {
    if (f.compression) flag('field-not-allowed', 'an uncompressed position has no compression type');
    const pos = uncompressedPosition(f);
    out += pos.text;
    latExtra = pos.latExtra;
    lonExtra = pos.lonExtra;
    daoApplied = (f.ambiguity ?? 0) === 0;
    if (hasCourse) {
      // DF or storm data with no course and speed follows `.../...`, which reads back as unknown
      // (vectors rulings, F8).
      out += courseSpeed(f.courseDegrees, f.speedKnots);
      if (f.dfBearing) {
        const b = f.dfBearing;
        out += `/${pad(whole(b.bearingDegrees, 0, 360, 'bearing'), 3)}/${whole(b.number, 0, 9, 'N')}${whole(b.range, 0, 9, 'R')}${whole(b.quality, 0, 9, 'Q')}`;
      }
      if (f.storm) out += stormText(f.storm);
    } else if (f.phg) {
      const p = f.phg;
      out += `PHG${whole(p.power, 0, 9, 'power code')}${heightChar(p.height)}${whole(p.gain, 0, 9, 'gain code')}${whole(p.directivity, 0, 9, 'directivity code')}`;
      if (p.beaconsPerHour !== undefined) out += rateChar(p.beaconsPerHour) + '/';
    } else if (f.rangeMiles !== undefined) {
      out += 'RNG' + pad(whole(f.rangeMiles, 0, 9999, 'range'), 4);
    } else if (f.dfs) {
      const d = f.dfs;
      out += `DFS${whole(d.strength, 0, 9, 'strength')}${heightChar(d.height)}${whole(d.gain, 0, 9, 'gain code')}${whole(d.directivity, 0, 9, 'directivity code')}`;
    } else if (f.area) {
      const a = f.area;
      const shape = AREA_SHAPES.indexOf(a.shape);
      const color = AREA_COLORS.indexOf(a.color);
      if (shape < 0 || color < 0) flag('invalid-code', 'unknown area shape or colour');
      const c = color < 10 ? `/${color}` : String(color);
      out += `${shape}${pad(whole(a.latOffset, 0, 99, 'area offset'), 2)}${c}${pad(whole(a.lonOffset, 0, 99, 'area offset'), 2)}`;
    }
  }
  // After the data extension: the frequency with its fields, first, where radios read it (APRS12c
  // ch. 18); the signpost or corridor braces; the altitude, unless the compressed cs bytes carry it
  // exactly; the free text; base-91 telemetry; the !DAO! (vectors rulings, E3).
  let text = '';
  // A frequency straight after a 7-byte extension follows a / (a PHGR already ends in one); after a
  // compressed position, or a position with no extension, it follows straight on.
  const extended = !f.compressed && (hasCourse || exts.length > 0);
  if (f.frequency) text += (extended && !out.endsWith('/') ? '/' : '') + frequencyText(f.frequency);
  let braces = '';
  if (f.signpost !== undefined) {
    // Printable ASCII, a space included, other than the braces around it.
    if (!/^[\x20-\x7a\x7c\x7e]{1,3}$/.test(f.signpost)) flag('invalid-character', 'a signpost is 1-3 printable ASCII characters other than { and }');
    braces = `{${f.signpost}}`;
  }
  if (f.area?.corridorWidthMiles !== undefined) {
    if (f.area.shape !== 'line-down-right' && f.area.shape !== 'line-down-left') flag('field-not-allowed', 'only a line has a corridor');
    braces = `{${whole(f.area.corridorWidthMiles, 0, 999, 'corridor width')}}`;
  }
  text += braces;
  if (f.altitudeFeet !== undefined && !altitudeInCs) text += altitudeText(f.altitudeFeet);
  const comment = f.comment ?? '';
  if (comment.length > 0 || mode === 'delimited') {
    // After a frequency (and anything after it) the free text follows a space, unless that would
    // make it read as one of the frequency's fields.
    if ((f.frequency && mode !== 'joined') || mode === 'spaced') text += ' ';
    text += (mode === 'delimited' ? '/' : '') + freeText(comment, 'the comment');
  }
  if (f.telemetry) text += telemetryText(f.telemetry);
  if (f.dao) text += daoText(f, latExtra, lonExtra, daoApplied);
  const body: Body = { text: out + text };
  if (compression) body.compression = compression;
  return body;
}

function stormText(s: NonNullable<PositionedFields['storm']>): string {
  const type = s.type === 'tropical-storm' ? 'TS' : s.type === 'hurricane' ? 'HC' : s.type === 'tropical-depression' ? 'TD' : refuse('invalid-code', 'unknown storm type');
  // Each field is digits: one with no value has no form (vectors README, storm data).
  const v = (n: number | undefined, width: number, what: string): string =>
    n === undefined ? refuse('missing-field', `storm data needs its ${what}`) : pad(whole(n, 0, 10 ** width - 1, what), width);
  let out = `/${type}/${v(s.sustainedWindKnots, 3, 'sustained wind')}^${v(s.gustKnots, 3, 'gust')}/${v(s.centralPressureMbar, 4, 'pressure')}>${v(s.hurricaneRadiusNm, 3, 'radius')}&${v(s.tropicalStormRadiusNm, 3, 'radius')}`;
  if (s.wholeGaleRadiusNm !== undefined) out += `%${v(s.wholeGaleRadiusNm, 3, 'radius')}`;
  return out;
}

function weatherBody(f: PositionedFields): Body {
  const w = f.weather!;
  if (f.comment !== undefined && f.comment.length > 0) flag('field-not-allowed', 'a weather report has no comment');
  // The wind holds the data extension (uncompressed) or the cs bytes (compressed).
  if (f.frequency || f.signpost !== undefined) flag('field-not-allowed', 'a weather report carries only weather data');
  if (f.phg || f.dfs || f.area || f.dfBearing || f.storm)
    flag(f.compressed ? 'field-not-allowed' : 'extension-conflict', 'a weather report carries only weather data');
  if (f.rangeMiles !== undefined && !f.compressed) flag('extension-conflict', 'a weather report carries only weather data');
  if (f.courseDegrees !== undefined || f.speedKnots !== undefined) flag('extension-conflict', 'a weather report has wind, not course and speed');
  if (f.telemetry) flag('field-not-allowed', 'comment telemetry goes in a comment, which a weather report does not have');
  let out = '';
  let compression: CompressionType | undefined;
  let latExtra = 0;
  let lonExtra = 0;
  let daoApplied = false;
  let altitudeInCs = false;
  if (f.compressed) {
    compression = f.compression;
    let cs: string | undefined;
    if (w.windDirectionDegrees !== undefined || w.windSpeedMph !== undefined) {
      if (w.windDirectionDegrees === undefined || w.windSpeedMph === undefined) flag('missing-field', 'compressed wind needs both direction and speed');
      const windDirection = w.windDirectionDegrees ?? 0;
      if (w.windDirectionDegrees !== undefined) whole(windDirection, 0, 360, 'wind direction');
      cs = compressedDirection(windDirection) + compressedSpeed((w.windSpeedMph ?? 0) / KNOTS_TO_MPH, 'wind speed');
      compression = compression ?? DEFAULT_COMPRESSION;
      if (compression.source === 'gga') flag('extension-conflict', 'a GGA compression type means the cs bytes hold altitude');
      if (f.rangeMiles !== undefined) flag('extension-conflict', 'the cs bytes hold the wind, so they cannot hold a range');
    } else if (f.altitudeFeet !== undefined && compression?.source === 'gga') {
      // With no comment to hold a /A=, the nearest value the cs bytes hold (vectors rulings, F14).
      cs = ggaAltitude(f.altitudeFeet).cs;
      altitudeInCs = true;
      if (f.rangeMiles !== undefined) flag('extension-conflict', 'the cs bytes hold the altitude, so they cannot hold a range');
    } else if (f.rangeMiles !== undefined) {
      if (compression?.source === 'gga') flag('extension-conflict', 'a GGA compression type means the cs bytes hold altitude');
      cs = compressedRange(f.rangeMiles);
      compression = compression ?? DEFAULT_COMPRESSION;
    } else if (compression !== undefined) {
      flag('missing-field', 'a compression type needs cs data');
    }
    const pos = compressedPosition(f, cs, compression);
    out += pos.text;
    latExtra = pos.latExtra;
    lonExtra = pos.lonExtra;
    daoApplied = true;
    if (f.altitudeFeet !== undefined && !altitudeInCs) flag('field-not-allowed', 'a weather report has no altitude in its comment');
    out += weatherFields(w, true);
  } else {
    if (f.compression) flag('field-not-allowed', 'an uncompressed position has no compression type');
    if (f.altitudeFeet !== undefined) flag('field-not-allowed', 'a weather report has no altitude in its comment');
    const pos = uncompressedPosition(f);
    out += pos.text;
    latExtra = pos.latExtra;
    lonExtra = pos.lonExtra;
    daoApplied = (f.ambiguity ?? 0) === 0;
    out += courseSpeed(w.windDirectionDegrees, w.windSpeedMph, 'wind direction');
    out += weatherFields(w, true);
  }
  if (f.telemetry) out += telemetryText(f.telemetry);
  if (f.dao) out += daoText(f, latExtra, lonExtra, daoApplied);
  const body: Body = { text: out };
  if (compression) body.compression = compression;
  return body;
}

// ---- the reports

export function encodePositionReport(d: PositionReport, mode: CommentMode): Body {
  let dti: string;
  let ts = '';
  if (d.timestamp) {
    ts = timestamp7(d.timestamp);
    dti = d.messaging ? '@' : '/';
  } else {
    dti = d.messaging ? '=' : '!';
  }
  const body = positionedBody(d, mode);
  return { ...body, text: dti + ts + body.text };
}

export function encodeObject(d: ObjectReport, mode: CommentMode): Body {
  if (!/^[\x20-\x7e]{1,9}$/.test(d.name)) flag('invalid-name', 'an object name is 1-9 printable ASCII characters');
  if (d.name.endsWith(' ')) flag('padding-space', 'an object name cannot end in a space, which reads as padding');
  if (!d.timestamp) flag('missing-field', 'an object report always has a timestamp');
  const ts = d.timestamp ? timestamp7(d.timestamp) : '';
  const body = positionedBody(d, mode);
  return { ...body, text: ';' + d.name.padEnd(9, ' ') + (d.killed ? '_' : '*') + ts + body.text };
}

export function encodeItem(d: ItemReport, mode: CommentMode): Body {
  if (!/^[\x20-\x7e]{3,9}$/.test(d.name)) flag('invalid-name', 'an item name is 3-9 printable ASCII characters');
  if (/[!_]/.test(d.name)) flag('invalid-name', 'an item name cannot contain ! or _');
  const body = positionedBody(d, mode);
  return { ...body, text: ')' + d.name + (d.killed ? '_' : '!') + body.text };
}

// ---- Mic-E (APRS12c ch. 10)

const STANDARD: Record<string, number> = {
  'off-duty': 7,
  'en-route': 6,
  'in-service': 5,
  returning: 4,
  committed: 3,
  special: 2,
  priority: 1,
  emergency: 0,
};
const CUSTOM: Record<string, number> = { custom0: 7, custom1: 6, custom2: 5, custom3: 4, custom4: 3, custom5: 2, custom6: 1 };

function micEDestination(d: MicEReport, lat: Digits, lonDegrees: number): string {
  const message: MicEMessage = d.micEMessage;
  let bits = 0;
  let custom = false;
  if (message in STANDARD) bits = STANDARD[message]!;
  else if (message in CUSTOM) {
    bits = CUSTOM[message]!;
    custom = true;
  } else flag('invalid-code', `the Mic-E message ${message} has no encoding`);
  const ambiguity = d.ambiguity ?? 0;
  const digits = pad(lat.degrees, 2) + pad(lat.hundredths, 4);
  let out = '';
  for (let k = 0; k < 6; k++) {
    const blanked = k >= 6 - ambiguity;
    const digit = digits.charCodeAt(k) - 48;
    let flag: boolean;
    if (k < 3) flag = ((bits >> (2 - k)) & 1) === 1;
    else if (k === 3) flag = !isNegative(d.latitude);
    else if (k === 4) flag = lonDegrees <= 9 || lonDegrees >= 100;
    else flag = isNegative(d.longitude);
    if (k < 3 && flag && custom) out += blanked ? 'K' : String.fromCharCode(65 + digit);
    else if (flag) out += blanked ? 'Z' : String.fromCharCode(80 + digit);
    else out += blanked ? 'L' : String.fromCharCode(48 + digit);
  }
  if (d.destinationSsid !== undefined && d.destinationSsid !== 0) {
    out += '-' + whole(d.destinationSsid, 0, 15, 'destination SSID');
  }
  return out;
}

export function micEAltitude(feet: number): string | undefined {
  const metres = nearest(feet * METRES_PER_FOOT);
  if (Math.abs(metres / METRES_PER_FOOT - feet) > 1e-6) return undefined;
  const v = metres + 10000;
  if (v < 0 || v > 91 ** 3 - 1) return undefined;
  return base91(v, 3) + '}';
}

/** A Mic-E report: the information field and the destination address. */
export function encodeMicE(d: MicEReport, mode: CommentMode): { text: string; destination: string } {
  if (d.compressed || d.compression) flag('field-not-allowed', 'a Mic-E report is not compressed');
  if (!(d.latitude >= -90 && d.latitude <= 90)) flag(numberFault(d.latitude), `latitude ${d.latitude} is out of range`);
  if (!(d.longitude >= -180 && d.longitude <= 180)) flag(numberFault(d.longitude), `longitude ${d.longitude} is out of range`);
  checkSymbol(d.symbol);
  if (d.weather) flag('field-not-allowed', 'a Mic-E report has no weather data');
  if (d.dfBearing || d.storm || d.area || d.signpost !== undefined) flag('field-not-allowed', 'a Mic-E report cannot carry that data');
  const ambiguity = d.ambiguity ?? 0;
  if (!Number.isInteger(ambiguity) || ambiguity < 0 || ambiguity > 4) flag(numberFault(ambiguity), 'ambiguity is 0-4 digits');
  const digits = digitsMode(d);
  const lat = digitsOf(d.latitude, digits, ambiguity);
  const lon = digitsOf(d.longitude, digits, ambiguity);
  if (lat.degrees > 90 || (lat.degrees === 90 && lat.hundredths > 0)) flag('value-out-of-range', 'latitude is out of range');
  if (lon.degrees > 179) flag('value-has-no-form', 'Mic-E longitude is below 180 degrees');
  if (ambiguity > 0 && lat.degrees === 90) flag('value-has-no-form', 'an ambiguous position at the pole has no form');
  const destination = micEDestination(d, lat, lon.degrees);
  // Longitude
  const deg = lon.degrees;
  let dByte: number;
  if (deg <= 9) dByte = deg + 90 + 28;
  else if (deg <= 99) dByte = deg + 28;
  else if (deg <= 109) dByte = deg + 8;
  else dByte = deg - 100 + 28;
  // With ambiguity the digits a decoder ignores are written as the centre it reports (vectors
  // README, Mic-E): 03.5x is 03.55, 03.xx 03.50, 0x.xx 05.00, xx.xx 30.00.
  let lonHundredths = lon.hundredths;
  if (ambiguity === 1) lonHundredths = Math.floor(lonHundredths / 10) * 10 + 5;
  else if (ambiguity === 2) lonHundredths = Math.floor(lonHundredths / 100) * 100 + 50;
  else if (ambiguity === 3) lonHundredths = Math.floor(lonHundredths / 1000) * 1000 + 500;
  else if (ambiguity === 4) lonHundredths = 3000;
  const mValue = Math.floor(lonHundredths / 100);
  const hundredths = lonHundredths % 100;
  const mByte = mValue < 10 ? mValue + 88 : mValue + 28;
  const hByte = hundredths + 28;
  // Speed and course in their printable forms (APRS12c ch. 10): speed tens + 80 below 190 knots,
  // and as they are from 190 on (190-199 is /, not DEL: vectors rulings, E5); course + 400.
  const speed = d.speedKnots === undefined ? 0 : whole(d.speedKnots, 0, 799, 'speed');
  // A course of 0 (after rounding) reads back as no course, so it is refused (vectors rulings, F1).
  const course = d.courseDegrees === undefined ? 0 : whole(d.courseDegrees, 1, 360, 'course', 'value-out-of-range', 0);
  const tens = Math.floor(speed / 10);
  const spByte = tens < 19 ? tens + 80 + 28 : tens + 28;
  const dcByte = (speed % 10) * 10 + Math.floor(course / 100) + 4 + 28;
  const seByte = (course % 100) + 28;
  const dti = d.oldData ? "'" : '`';
  let info = dti + String.fromCharCode(dByte, mByte, hByte, spByte, dcByte, seByte) + d.symbol.code + d.symbol.table;

  if (d.legacyTelemetry && d.legacyTelemetry.length > 0) {
    // A 255 would be taken for Kenwood 0xFF padding and removed on the way back in.
    if (d.legacyTelemetry.length !== 5) flag('malformed', 'obsolete Mic-E binary telemetry is 5 values, each 0-254');
    else if (d.legacyTelemetry.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) flag('value-out-of-range', 'obsolete Mic-E binary telemetry is 5 values, each 0-254');
    else if (d.legacyTelemetry.some((v) => v === 255)) flag('value-has-no-form', 'obsolete Mic-E binary telemetry is 5 values, each 0-254');
    info += String.fromCharCode(0x1d, ...d.legacyTelemetry);
  }

  // Status text: type code, altitude, locator, then the comment elements, then the suffix.
  let text = '';
  if (d.typeCode !== undefined) {
    if (!'`\'>] '.includes(d.typeCode) || d.typeCode.length !== 1) flag('invalid-code', 'the Mic-E type code is `, \', >, ] or a space');
    text += d.typeCode;
  }
  let altitudeInComment: number | undefined;
  if (d.altitudeFeet !== undefined) {
    const alt = d.altitudeInComment ? undefined : micEAltitude(d.altitudeFeet);
    if (alt !== undefined) text += alt;
    else altitudeInComment = d.altitudeFeet;
  }
  let after = '';
  const exts = [d.phg ? 1 : 0, d.rangeMiles !== undefined ? 1 : 0, d.dfs ? 1 : 0].reduce((a, b) => a + b, 0);
  if (exts > 1) flag('extension-conflict', 'only one data extension can follow');
  if (d.phg) {
    const p = d.phg;
    after += `PHG${whole(p.power, 0, 9, 'power code')}${heightChar(p.height)}${whole(p.gain, 0, 9, 'gain code')}${whole(p.directivity, 0, 9, 'directivity code')}`;
    if (p.beaconsPerHour !== undefined) after += rateChar(p.beaconsPerHour) + '/';
  } else if (d.rangeMiles !== undefined) {
    after += 'RNG' + pad(whole(d.rangeMiles, 0, 9999, 'range'), 4);
  } else if (d.dfs) {
    const x = d.dfs;
    after += `DFS${whole(x.strength, 0, 9, 'strength')}${heightChar(x.height)}${whole(x.gain, 0, 9, 'gain code')}${whole(x.directivity, 0, 9, 'directivity code')}`;
  }
  if (altitudeInComment !== undefined) after += altitudeText(altitudeInComment);
  let rest = '';
  if (d.frequency) rest += (exts > 0 && altitudeInComment === undefined && !after.endsWith('/') ? '/' : '') + frequencyText(d.frequency);
  const comment = d.comment ?? '';
  if (comment.length > 0 || mode === 'delimited') {
    if ((rest.length > 0 && mode !== 'joined') || mode === 'spaced') rest += ' ';
    rest += (mode === 'delimited' ? '/' : '') + freeText(comment, 'the comment');
  }
  after += rest;
  // Telemetry and the !DAO! are lifted before a locator is read, so they follow it straight on
  // (vectors rulings, F16).
  let lifted = '';
  if (d.telemetry) lifted += telemetryText(d.telemetry);
  if (d.dao) lifted += daoText(d, lat.extra, lon.extra, ambiguity === 0);
  if (d.locator !== undefined) {
    if (!/^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/.test(d.locator)) flag('malformed', 'the locator is 4 or 6 characters, upper case');
    text += `${d.locator}/G`;
    if (after.length > 0) text += ' ';
  }
  text += after + lifted;
  if (d.deviceSuffix !== undefined) {
    if (d.typeCode === undefined) flag('missing-field', 'a Mic-E device suffix needs a type code');
    else if (identifyMicE(d.typeCode, d.deviceSuffix) === undefined) flag('invalid-code', 'the Mic-E device suffix is not one the device database knows for the type code');
    text += d.deviceSuffix;
  }
  // Mic-E status text must not start with 0x1D, which would be taken for Rev 0 telemetry
  // (APRS12c ch. 10), so a comment that would start it is written after a /.
  const legacy = d.legacyTelemetry !== undefined && d.legacyTelemetry.length > 0;
  if (!legacy && text.startsWith('\x1d') && mode !== 'delimited') return encodeMicE(d, 'delimited');
  info += text;
  return { text: info, destination };
}

export type { AprsSymbol };
