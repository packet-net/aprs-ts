// Encoding positions, objects, items and Mic-E reports, with their data extensions, weather and
// comment elements, in the canonical order: extension, altitude, frequency, comment, base-91
// telemetry, !DAO! (and for Mic-E, the device suffix last).

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
import { base91, checkSymbol, freeText, isValidTimestamp, pad, refuse, timestamp7, whole } from './common.js';

const EPS = 1e-9;

/** Negative, or negative zero: a zero coordinate keeps its hemisphere as the sign of zero. */
export function isNegative(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

// ---- coordinates

interface Digits {
  degrees: number;
  /** Hundredths of a minute. */
  hundredths: number;
  /** The remainder below a hundredth, in minutes (for a !DAO!). */
  remainder: number;
}

/** Degrees and hundredths of a minute; truncated when a !DAO! or ambiguity follows, else rounded. */
function digitsOf(value: number, truncate: boolean): Digits {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs + EPS);
  let minutes = (abs - degrees) * 60;
  if (minutes < 0) minutes = 0;
  let hundredths = truncate ? Math.floor(minutes * 100 + EPS) : Math.round(minutes * 100);
  if (hundredths >= 6000) {
    degrees += 1;
    hundredths -= 6000;
  }
  const remainder = Math.max(0, minutes - hundredths / 100);
  return { degrees, hundredths, remainder };
}

function blank(text: string, positions: readonly number[], ambiguity: number): string {
  const chars = text.split('');
  for (let k = 0; k < ambiguity; k++) chars[positions[positions.length - 1 - k]!] = ' ';
  return chars.join('');
}

/** `ddmm.hhN/dddmm.hhW$`, with the DAO remainders. */
function uncompressedPosition(
  f: PositionedFields,
  truncate: boolean,
): { text: string; latRemainder: number; lonRemainder: number } {
  if (!(f.latitude >= -90 && f.latitude <= 90)) refuse(`latitude ${f.latitude} is out of range`);
  if (!(f.longitude >= -180 && f.longitude <= 180)) refuse(`longitude ${f.longitude} is out of range`);
  const ambiguity = f.ambiguity ?? 0;
  if (!Number.isInteger(ambiguity) || ambiguity < 0 || ambiguity > 4) refuse('ambiguity is 0-4 digits');
  checkSymbol(f.symbol);
  const lat = digitsOf(f.latitude, truncate || ambiguity > 0);
  const lon = digitsOf(f.longitude, truncate || ambiguity > 0);
  if (lat.degrees > 90 || (lat.degrees === 90 && lat.hundredths > 0)) refuse('latitude is out of range');
  if (lon.degrees > 180 || (lon.degrees === 180 && lon.hundredths > 0)) refuse('longitude is out of range');
  const latMin = pad(Math.floor(lat.hundredths / 100), 2) + '.' + pad(lat.hundredths % 100, 2);
  const lonMin = pad(Math.floor(lon.hundredths / 100), 2) + '.' + pad(lon.hundredths % 100, 2);
  const latText = blank(pad(lat.degrees, 2) + latMin, [2, 3, 5, 6], ambiguity) + (isNegative(f.latitude) ? 'S' : 'N');
  const lonText = blank(pad(lon.degrees, 3) + lonMin, [3, 4, 6, 7], ambiguity) + (isNegative(f.longitude) ? 'W' : 'E');
  return {
    text: latText + f.symbol.table + lonText + f.symbol.code,
    latRemainder: lat.remainder,
    lonRemainder: lon.remainder,
  };
}

const SOURCES = ['other', 'gll', 'gga', 'rmc'];
const ORIGINS = ['compressed', 'tnc-beacon-text', 'software', 'reserved3', 'kpc3', 'pico', 'other-tracker', 'digipeater-conversion'];

export const DEFAULT_COMPRESSION: CompressionType = { fix: 'current', source: 'other', origin: 'software' };

function typeByte(c: CompressionType): string {
  const source = SOURCES.indexOf(c.source);
  const origin = ORIGINS.indexOf(c.origin);
  if (source < 0 || origin < 0 || (c.fix !== 'old' && c.fix !== 'current')) refuse('the compression type is not one APRS defines');
  return String.fromCharCode(((c.fix === 'current' ? 1 : 0) << 5) + (source << 3) + origin + 33);
}

/** The compressed position; `cs` is the two cs bytes or `undefined` for none. */
function compressedPosition(f: PositionedFields, cs: string | undefined, compression: CompressionType | undefined): string {
  if (!(f.latitude >= -90 && f.latitude <= 90)) refuse(`latitude ${f.latitude} is out of range`);
  if (!(f.longitude >= -180 && f.longitude <= 180)) refuse(`longitude ${f.longitude} is out of range`);
  if ((f.ambiguity ?? 0) !== 0) refuse('a compressed position cannot be ambiguous');
  checkSymbol(f.symbol);
  let table = f.symbol.table;
  if (table >= '0' && table <= '9') table = String.fromCharCode(table.charCodeAt(0) + 49); // 0-9 -> a-j
  const max = 91 ** 4 - 1;
  const y = Math.min(max, Math.max(0, Math.round(380926 * (90 - f.latitude))));
  const x = Math.min(max, Math.max(0, Math.round(190463 * (180 + f.longitude))));
  const tail = cs === undefined ? ' sT' : cs + typeByte(compression ?? DEFAULT_COMPRESSION);
  return table + base91(y, 4) + base91(x, 4) + f.symbol.code + tail;
}

/**
 * A GGA altitude in the cs bytes: 1.002^cs feet, so the nearest value they hold (1 foot for 0 feet
 * or below), and whether that is exact. When it is not, a `/A=` altitude carries it and wins.
 */
function ggaAltitude(feet: number): { cs: string; exact: boolean } {
  if (!Number.isFinite(feet)) refuse('altitude is not a number');
  const v = feet <= 1 ? 0 : Math.round(Math.log(feet) / Math.log(1.002));
  if (v > 91 * 91 - 1) refuse('altitude is too high for the compressed format');
  const cs = String.fromCharCode(Math.floor(v / 91) + 33) + String.fromCharCode((v % 91) + 33);
  return { cs, exact: Math.abs(Math.pow(1.002, v) - feet) <= 1e-9 * Math.abs(feet) };
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

function altitudeText(feet: number): string {
  if (!Number.isInteger(feet)) refuse('an /A= altitude is whole feet');
  if (feet < 0) {
    if (feet < -99999) refuse('altitude is out of range');
    return `/A=-${pad(-feet, 5)}`;
  }
  if (feet > 999999) refuse('altitude is out of range');
  return `/A=${pad(feet, 6)}`;
}

export function frequencyText(f: VoiceFrequency): string {
  const mhz = f.mhz;
  if (!(mhz >= 0)) refuse('the frequency is negative');
  let whole3: string;
  let fraction: string;
  const resolution = f.tenKhzResolution ? 100 : 1000;
  const scaled = Math.round(mhz * resolution);
  const intPart = Math.floor(scaled / resolution);
  const fracPart = scaled % resolution;
  fraction = pad(fracPart, f.tenKhzResolution ? 2 : 3);
  if (intPart < 1000) {
    whole3 = pad(intPart, 3);
  } else {
    const letter = Object.entries(MICROWAVE_BASE).find(([, base]) => intPart >= base && intPart < base + 100);
    if (!letter) refuse(`${mhz} MHz has no APRS frequency form`);
    whole3 = letter[0] + pad(intPart - letter[1], 2);
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
        const letter = f.tone === 'tone' ? 'T' : f.tone === 'ctcss' ? 'C' : f.tone === 'dcs' ? 'D' : refuse('unknown tone type');
        if (f.toneValue === undefined) refuse('a tone needs its value');
        out += ' ' + (narrow ? letter.toLowerCase() : letter) + pad(whole(f.toneValue, 0, 999, 'tone'), 3);
      }
    }
  } else if (f.narrow) {
    refuse('narrow modulation is written with the tone');
  }
  if (f.offsetKhz !== undefined) {
    if (f.offsetKhz % 10 !== 0) refuse('the offset is in tens of kHz');
    const v = whole(Math.abs(f.offsetKhz) / 10, 0, 999, 'offset');
    out += ` ${f.offsetKhz < 0 ? '-' : '+'}${pad(v, 3)}`;
  }
  if (f.range !== undefined) {
    out += ` R${pad(whole(f.range, 0, 999, 'range'), 2)}${f.rangeKm ? 'k' : 'm'}`;
  } else if (f.rangeKm) {
    refuse('range in km needs a range');
  }
  return out;
}

export function telemetryText(t: CommentTelemetry): string {
  if (t.analog.length < 1 || t.analog.length > 5) refuse('comment telemetry has 1-5 analog values');
  if (t.digital !== undefined && t.analog.length !== 5) refuse('comment telemetry bits come after all five analog values');
  const v = (n: number, what: string): string => base91(whole(n, 0, 8280, what), 2);
  let out = '|' + v(t.sequence, 'telemetry sequence');
  for (const a of t.analog) out += v(a, 'telemetry value');
  // Eight binary channels; bits 9-13 are reserved.
  if (t.digital !== undefined) out += base91(whole(t.digital, 0, 255, 'telemetry bits'), 2);
  return out + '|';
}

function daoText(f: PositionedFields, latRemainder: number, lonRemainder: number, applied: boolean): string {
  const dao = f.dao!;
  const datum = dao.datum;
  if (/^[0-9]$/.test(datum)) {
    // A local datum digit has no case to give a precision, so it only goes with spaces.
    if (dao.precision !== 'none') refuse('a !DAO! datum digit carries no added precision');
    return `!${datum}  !`;
  }
  if (!/^[A-Za-z]$/.test(datum)) refuse('the !DAO! datum is a letter or a digit');
  switch (dao.precision) {
    case 'none':
      return `!${datum.toUpperCase()}  !`;
    case 'thousandths': {
      if (!applied) return `!${datum.toUpperCase()}00!`;
      const a = Math.min(9, Math.round(latRemainder * 1000));
      const o = Math.min(9, Math.round(lonRemainder * 1000));
      return `!${datum.toUpperCase()}${a}${o}!`;
    }
    case 'base91': {
      if (!applied) return `!${datum.toLowerCase()}!!!`;
      const a = Math.min(90, Math.round(latRemainder * 100 * 91));
      const o = Math.min(90, Math.round(lonRemainder * 100 * 91));
      return `!${datum.toLowerCase()}${String.fromCharCode(a + 33)}${String.fromCharCode(o + 33)}!`;
    }
  }
}

// ---- weather

function weatherValue(v: number | undefined, width: number, min: number, max: number, what: string): string {
  if (v === undefined) return '.'.repeat(width);
  const n = whole(v, min, max, what);
  if (n < 0) return '-' + pad(-n, width - 1);
  return pad(n, width);
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
    const h = whole(w.humidityPercent, 1, 100, 'humidity');
    out += 'h' + (h === 100 ? '00' : pad(h, 2));
  }
  if (w.pressureMbar !== undefined) out += 'b' + weatherValue(w.pressureMbar * 10, 5, 0, 99999, 'pressure');
  if (w.luminosityWM2 !== undefined) {
    const l = whole(w.luminosityWM2, 0, 1999, 'luminosity');
    out += l < 1000 ? 'L' + pad(l, 3) : 'l' + pad(l - 1000, 3);
  }
  if (w.snow24hIn !== undefined) {
    const s = w.snow24hIn;
    let text = Number.isInteger(s) ? pad(whole(s, 0, 999, 'snowfall'), 3) : String(s);
    if (text.length !== 3 || !/^[0-9.]{3}$/.test(text)) text = refuse('snowfall is 3 characters');
    out += 's' + text;
  }
  if (w.rainRaw !== undefined) out += '#' + pad(whole(w.rainRaw, 0, 999, 'raw rain counter'), 3);
  for (const e of w.extra ?? []) {
    if (!/^[A-Za-z]$/.test(e.letter) || 'csgtrpPhbLl'.includes(e.letter)) refuse(`${e.letter} is not an extra weather field letter`);
    if (!/^[0-9.-]{2,}$/.test(e.value) || !/[0-9]$/.test(e.value)) refuse('an extra weather field is digits, dots or -, ending in a digit');
    out += e.letter + e.value;
  }
  if (w.software !== undefined || w.unit !== undefined) {
    if (w.software === undefined || !/^[A-Za-z]$/.test(w.software)) refuse('the weather software type is one letter');
    if (w.unit === undefined || !/^[A-Za-z0-9_-]{2,4}$/.test(w.unit) || /^[0-9]+$/.test(w.unit))
      refuse('the weather unit is 2-4 letters, digits, - or _');
    out += w.software + w.unit;
  }
  return out;
}

/** A positionless weather report (`_`). */
export function encodeWeatherReport(d: WeatherReport): string {
  if (!d.timestamp || d.timestamp.kind !== 'mdhm') refuse('a positionless weather report has a month/day/hour/minute timestamp');
  if (!isValidTimestamp(d.timestamp)) refuse('the timestamp is out of range');
  if (d.comment !== undefined && d.comment.length > 0) refuse('a weather report has no comment');
  const t = d.timestamp;
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
 * (straight after a frequency, with no space) or `delimited` (after a `/`), for when it would
 * otherwise read as something else.
 */
export type CommentMode = 'plain' | 'joined' | 'delimited';

/** Encodes a position and what follows it. */
function positionedBody(f: PositionedFields, mode: CommentMode): Body {
  const isWeather = f.symbol.code === '_';
  if (f.weather && !isWeather) refuse('weather data needs the weather station symbol (_)');
  if (isWeather && !f.weather) refuse('the weather station symbol (_) needs weather data');
  if (isWeather) return weatherBody(f);
  const exts = hasExtension(f);
  const hasCourse = f.courseDegrees !== undefined || f.speedKnots !== undefined;
  if (exts.length + (hasCourse ? 1 : 0) > 1) refuse(`only one data extension can follow the symbol (${[hasCourse ? 'course/speed' : '', ...exts].filter(Boolean).join(', ')})`);
  if (f.dfBearing && !(f.symbol.table === '/' && f.symbol.code === '\\')) refuse('a DF bearing needs the DF symbol (/\\)');
  if (f.storm && !(f.symbol.code === '@' && (f.symbol.table === '/' || f.symbol.table === '\\'))) refuse('storm data needs a hurricane symbol (/@ or \\@)');
  if (f.signpost !== undefined && !(f.symbol.table === '\\' && f.symbol.code === 'm')) refuse('a signpost needs the signpost symbol (\\m)');
  if (f.area && !(f.symbol.table === '\\' && f.symbol.code === 'l')) refuse('an area object needs the area symbol (\\l)');

  let out = '';
  let compression: CompressionType | undefined;
  let altitudeInCs = false;
  let latRem = 0;
  let lonRem = 0;
  let daoApplied = false;
  if (f.compressed) {
    if (f.phg || f.dfs || f.area || f.dfBearing || f.storm) refuse('a compressed report carries only course/speed, range or altitude');
    let cs: string | undefined;
    compression = f.compression;
    if (hasCourse) {
      if (f.courseDegrees === undefined) refuse('a compressed course/speed needs a course');
      if (compression?.source === 'gga') refuse('a GGA compression type means the cs bytes hold altitude');
      const c = whole(f.courseDegrees, 1, 360, 'course') % 360;
      if (c % 4 !== 0 && Math.abs(Math.round(c / 4) * 4 - f.courseDegrees) > 2) refuse('course is out of range');
      const speed = f.speedKnots ?? 0;
      if (speed < 0) refuse('speed is negative');
      const s = Math.round(Math.log(speed + 1) / Math.log(1.08));
      if (s > 90) refuse('speed is too high for the compressed format');
      cs = String.fromCharCode(Math.round(c / 4) % 90 + 33) + String.fromCharCode(s + 33);
      compression = compression ?? DEFAULT_COMPRESSION;
    } else if (f.rangeMiles !== undefined) {
      if (compression?.source === 'gga') refuse('a GGA compression type means the cs bytes hold altitude');
      const s = Math.round(Math.log(f.rangeMiles / 2) / Math.log(1.08));
      if (!(s >= 0 && s <= 90)) refuse('range is out of range for the compressed format');
      cs = '{' + String.fromCharCode(s + 33);
      compression = compression ?? DEFAULT_COMPRESSION;
    } else if (f.altitudeFeet !== undefined && compression?.source === 'gga') {
      const alt = ggaAltitude(f.altitudeFeet);
      cs = alt.cs;
      altitudeInCs = alt.exact;
    } else if (compression !== undefined) {
      refuse('a compression type needs cs data (course/speed, range or altitude)');
    }
    out += compressedPosition(f, cs, compression);
  } else {
    if (f.compression) refuse('an uncompressed position has no compression type');
    const pos = uncompressedPosition(f, f.dao !== undefined);
    out += pos.text;
    latRem = pos.latRemainder;
    lonRem = pos.lonRemainder;
    daoApplied = (f.ambiguity ?? 0) === 0;
    if (hasCourse) {
      out += courseSpeed(f.courseDegrees, f.speedKnots);
      if (f.dfBearing) {
        const b = f.dfBearing;
        out += `/${pad(whole(b.bearingDegrees, 0, 360, 'bearing'), 3)}/${whole(b.number, 0, 9, 'N')}${whole(b.range, 0, 9, 'R')}${whole(b.quality, 0, 9, 'Q')}`;
      }
      if (f.storm) out += stormText(f.storm);
    } else if (f.dfBearing || f.storm) {
      refuse('DF and storm data follow a course/speed extension');
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
      if (shape < 0 || color < 0) refuse('unknown area shape or colour');
      const c = color < 10 ? `/${color}` : String(color);
      out += `${shape}${pad(whole(a.latOffset, 0, 99, 'area offset'), 2)}${c}${pad(whole(a.lonOffset, 0, 99, 'area offset'), 2)}`;
    }
  }
  // Altitude, unless the compressed cs bytes carry it exactly.
  if (f.altitudeFeet !== undefined && !altitudeInCs) out += altitudeText(f.altitudeFeet);
  const extensionEnded = !f.compressed && (hasCourse || exts.length > 0) && f.altitudeFeet === undefined;
  let text = '';
  // A frequency straight after a 7-byte extension is separated from it by / (a PHGR already ends in one).
  if (f.frequency) text += (extensionEnded && !out.endsWith('/') ? '/' : '') + frequencyText(f.frequency);
  let braces = '';
  if (f.signpost !== undefined) {
    if (!/^[\x21-\x7c\x7e]{1,3}$/.test(f.signpost) || f.signpost.includes('{') || f.signpost.includes('}')) refuse('a signpost is 1-3 printable characters');
    braces = `{${f.signpost}}`;
  }
  if (f.area?.corridorWidthMiles !== undefined) {
    if (f.area.shape !== 'line-down-right' && f.area.shape !== 'line-down-left') refuse('only a line has a corridor');
    braces = `{${whole(f.area.corridorWidthMiles, 0, 999, 'corridor width')}}`;
  }
  const comment = f.comment ?? '';
  if (comment.length > 0 || mode === 'delimited') {
    if (text.length > 0 && mode !== 'joined') text += ' ';
    text += (mode === 'delimited' ? '/' : '') + freeText(comment, 'the comment');
  }
  text += braces;
  if (f.telemetry) text += telemetryText(f.telemetry);
  if (f.dao) text += daoText(f, latRem, lonRem, daoApplied);
  const body: Body = { text: out + text };
  if (compression) body.compression = compression;
  return body;
}

function stormText(s: NonNullable<PositionedFields['storm']>): string {
  const type = s.type === 'tropical-storm' ? 'TS' : s.type === 'hurricane' ? 'HC' : s.type === 'tropical-depression' ? 'TD' : refuse('unknown storm type');
  const v = (n: number | undefined, width: number, what: string): string => (n === undefined ? ' '.repeat(width) : pad(whole(n, 0, 10 ** width - 1, what), width));
  let out = `/${type}/${v(s.sustainedWindKnots, 3, 'sustained wind')}^${v(s.gustKnots, 3, 'gust')}/${v(s.centralPressureMbar, 4, 'pressure')}>${v(s.hurricaneRadiusNm, 3, 'radius')}&${v(s.tropicalStormRadiusNm, 3, 'radius')}`;
  if (s.wholeGaleRadiusNm !== undefined) out += `%${v(s.wholeGaleRadiusNm, 3, 'radius')}`;
  return out;
}

function weatherBody(f: PositionedFields): Body {
  const w = f.weather!;
  if (f.comment !== undefined && f.comment.length > 0) refuse('a weather report has no comment');
  if (f.phg || f.dfs || f.area || f.dfBearing || f.storm || f.frequency || f.signpost !== undefined)
    refuse('a weather report carries only weather data');
  if (f.rangeMiles !== undefined && !f.compressed) refuse('a weather report carries only weather data');
  if (f.courseDegrees !== undefined || f.speedKnots !== undefined) refuse('a weather report has wind, not course and speed');
  if (f.telemetry) refuse('comment telemetry goes in a comment, which a weather report does not have');
  let out = '';
  let compression: CompressionType | undefined;
  let latRem = 0;
  let lonRem = 0;
  let daoApplied = false;
  let altitudeInCs = false;
  if (f.compressed) {
    compression = f.compression;
    let cs: string | undefined;
    if (w.windDirectionDegrees !== undefined || w.windSpeedMph !== undefined) {
      if (w.windDirectionDegrees === undefined || w.windSpeedMph === undefined) refuse('compressed wind needs both direction and speed');
      const dir = whole(w.windDirectionDegrees, 0, 360, 'wind direction');
      const knots = w.windSpeedMph / KNOTS_TO_MPH;
      const s = Math.round(Math.log(knots + 1) / Math.log(1.08));
      if (s < 0 || s > 90) refuse('wind speed is out of range for the compressed format');
      cs = String.fromCharCode((Math.round(dir / 4) % 90) + 33) + String.fromCharCode(s + 33);
      compression = compression ?? DEFAULT_COMPRESSION;
      if (compression.source === 'gga') refuse('a GGA compression type means the cs bytes hold altitude');
    } else if (f.altitudeFeet !== undefined && compression?.source === 'gga') {
      const alt = ggaAltitude(f.altitudeFeet);
      cs = alt.cs;
      altitudeInCs = alt.exact;
    } else if (f.rangeMiles !== undefined) {
      if (compression?.source === 'gga') refuse('a GGA compression type means the cs bytes hold altitude');
      const s = Math.round(Math.log(f.rangeMiles / 2) / Math.log(1.08));
      if (!(s >= 0 && s <= 90)) refuse('range is out of range for the compressed format');
      cs = '{' + String.fromCharCode(s + 33);
      compression = compression ?? DEFAULT_COMPRESSION;
    } else if (compression !== undefined) {
      refuse('a compression type needs cs data');
    }
    out += compressedPosition(f, cs, compression);
    if (f.altitudeFeet !== undefined && !altitudeInCs) refuse('a weather report has no altitude in its comment');
    out += weatherFields(w, true);
  } else {
    if (f.compression) refuse('an uncompressed position has no compression type');
    if (f.altitudeFeet !== undefined) refuse('a weather report has no altitude in its comment');
    const pos = uncompressedPosition(f, f.dao !== undefined);
    out += pos.text;
    latRem = pos.latRemainder;
    lonRem = pos.lonRemainder;
    daoApplied = (f.ambiguity ?? 0) === 0;
    out += courseSpeed(w.windDirectionDegrees, w.windSpeedMph, 'wind direction');
    out += weatherFields(w, true);
  }
  if (f.telemetry) out += telemetryText(f.telemetry);
  if (f.dao) out += daoText(f, latRem, lonRem, daoApplied);
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
  if (!/^[\x20-\x7e]{1,9}$/.test(d.name)) refuse('an object name is 1-9 printable ASCII characters');
  if (d.name.endsWith(' ')) refuse('an object name cannot end in a space, which reads as padding');
  if (!d.timestamp) refuse('an object report always has a timestamp');
  const ts = timestamp7(d.timestamp);
  const body = positionedBody(d, mode);
  return { ...body, text: ';' + d.name.padEnd(9, ' ') + (d.killed ? '_' : '*') + ts + body.text };
}

export function encodeItem(d: ItemReport, mode: CommentMode): Body {
  if (!/^[\x20-\x7e]{3,9}$/.test(d.name)) refuse('an item name is 3-9 printable ASCII characters');
  if (/[!_]/.test(d.name)) refuse('an item name cannot contain ! or _');
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
  let bits: number;
  let custom = false;
  if (message in STANDARD) bits = STANDARD[message]!;
  else if (message in CUSTOM) {
    bits = CUSTOM[message]!;
    custom = true;
  } else refuse(`the Mic-E message ${message} has no encoding`);
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
  const metres = Math.round(feet * METRES_PER_FOOT);
  if (Math.abs(metres / METRES_PER_FOOT - feet) > 1e-6) return undefined;
  const v = metres + 10000;
  if (v < 0 || v > 91 ** 3 - 1) return undefined;
  return base91(v, 3) + '}';
}

/** A Mic-E report: the information field and the destination address. */
export function encodeMicE(d: MicEReport, mode: CommentMode): { text: string; destination: string } {
  if (d.compressed || d.compression) refuse('a Mic-E report is not compressed');
  if (!(d.latitude >= -90 && d.latitude <= 90)) refuse(`latitude ${d.latitude} is out of range`);
  if (!(d.longitude >= -180 && d.longitude <= 180)) refuse(`longitude ${d.longitude} is out of range`);
  checkSymbol(d.symbol);
  if (d.weather) refuse('a Mic-E report has no weather data');
  if (d.dfBearing || d.storm || d.area || d.signpost !== undefined) refuse('a Mic-E report cannot carry that data');
  const ambiguity = d.ambiguity ?? 0;
  if (!Number.isInteger(ambiguity) || ambiguity < 0 || ambiguity > 4) refuse('ambiguity is 0-4 digits');
  const truncate = d.dao !== undefined || ambiguity > 0;
  const lat = digitsOf(d.latitude, truncate);
  const lon = digitsOf(d.longitude, truncate);
  if (lat.degrees > 90 || (lat.degrees === 90 && lat.hundredths > 0)) refuse('latitude is out of range');
  if (lon.degrees > 179) refuse('Mic-E longitude is below 180 degrees');
  const destination = micEDestination(d, lat, lon.degrees);
  // Longitude
  const deg = lon.degrees;
  let dByte: number;
  if (deg <= 9) dByte = deg + 90 + 28;
  else if (deg <= 99) dByte = deg + 28;
  else if (deg <= 109) dByte = deg + 8;
  else dByte = deg - 100 + 28;
  // With ambiguity the digits a decoder ignores are written as the centre it reports.
  const mValue = Math.floor(lon.hundredths / 100);
  const hundredths = lon.hundredths % 100;
  const mByte = mValue < 10 ? mValue + 88 : mValue + 28;
  const hByte = hundredths + 28;
  // Speed and course: speed tens + 80 (so values under 200 knots are printable), course + 400.
  const speed = d.speedKnots === undefined ? 0 : whole(d.speedKnots, 0, 799, 'speed');
  const course = d.courseDegrees === undefined ? 0 : whole(d.courseDegrees, 0, 360, 'course');
  const tens = Math.floor(speed / 10);
  const spByte = tens < 20 ? tens + 80 + 28 : tens + 28;
  const dcByte = (speed % 10) * 10 + Math.floor(course / 100) + 4 + 28;
  const seByte = (course % 100) + 28;
  const dti = d.oldData ? "'" : '`';
  let info = dti + String.fromCharCode(dByte, mByte, hByte, spByte, dcByte, seByte) + d.symbol.code + d.symbol.table;

  if (d.legacyTelemetry && d.legacyTelemetry.length > 0) {
    // A 255 would be taken for Kenwood 0xFF padding and removed on the way back in.
    if (d.legacyTelemetry.length !== 5 || d.legacyTelemetry.some((v) => !Number.isInteger(v) || v < 0 || v > 254)) {
      refuse('obsolete Mic-E binary telemetry is 5 values, each 0-254');
    }
    info += String.fromCharCode(0x1d, ...d.legacyTelemetry);
  }

  // Status text: type code, altitude, locator, then the comment elements, then the suffix.
  let text = '';
  if (d.typeCode !== undefined) {
    if (!'`\'>] '.includes(d.typeCode) || d.typeCode.length !== 1) refuse('the Mic-E type code is `, \', >, ] or a space');
    text += d.typeCode;
  }
  let altitudeInComment: number | undefined;
  if (d.altitudeFeet !== undefined) {
    const alt = micEAltitude(d.altitudeFeet);
    if (alt !== undefined) text += alt;
    else altitudeInComment = d.altitudeFeet;
  }
  let after = '';
  const exts = [d.phg ? 1 : 0, d.rangeMiles !== undefined ? 1 : 0, d.dfs ? 1 : 0].reduce((a, b) => a + b, 0);
  if (exts > 1) refuse('only one data extension can follow');
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
    if (rest.length > 0 && mode !== 'joined') rest += ' ';
    rest += (mode === 'delimited' ? '/' : '') + freeText(comment, 'the comment');
  }
  after += rest;
  if (d.telemetry) after += telemetryText(d.telemetry);
  if (d.dao) after += daoText(d, lat.remainder, lon.remainder, ambiguity === 0);
  if (d.locator !== undefined) {
    if (!/^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/.test(d.locator)) refuse('the locator is 4 or 6 characters, upper case');
    text += `${d.locator}/G`;
    if (after.length > 0) text += ' ';
  }
  text += after;
  if (d.deviceSuffix !== undefined) {
    if (d.typeCode === undefined) refuse('a Mic-E device suffix needs a type code');
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
