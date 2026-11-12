// Differential dump, in the three modes of aprs-vectors' README ("Comparing implementations"),
// read by its tools/compare.py. Every file is gzip-compressed JSON lines, in the input's order.
//
//   npm run build
//   node scripts/diff-dump.mjs lines.hex.gz ts.jsonl.gz [--limit N]             decode (the default)
//   node scripts/diff-dump.mjs --encode data.jsonl.gz ts.jsonl.gz [--limit N]   encode
//   node scripts/diff-dump.mjs --build recipes.jsonl.gz ts.jsonl.gz [--limit N] build
//
// decode: one hex-encoded TNC2 line per input line; writes
//   {"n", "lenient": R, "strict": R, "reencode": "identical|equivalent|refused|fails|none",
//    "written": "hex", "written_destination": "...", "reencode_refusal": "id", "api": A}
// where R is {"header", "data", "diagnostics"} in the neutral form, or {"header_error": [...]};
// written is the information field the encoder wrote (whenever it wrote one), written_destination
// the Mic-E destination it computed, reencode_refusal the refusal code when reencode is refused,
// and api the API view of the lenient packet (with ax25_refusal beside ax25 "refused").
//
// encode: {"n", "data", "exact"} per line, data in the neutral form; writes
//   {"n", "result": "written|refused|unsupported", "info", "destination", "again", "reason", "refusal"}
//
// build: a builder recipe per line; writes
//   {"n", "result": "built|refused|unsupported", "tnc2", "again", "reason", "refusal"}

import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import {
  Aprs,
  AprsEncodeError,
  AprsHeaderError,
  decodeTnc2,
  describeSymbol,
  encodeInformation,
  formatDiagnostic,
  hasErrors,
  hasWarnings,
  packetToAx25,
  packetToTnc2Bytes,
  ParseOptions,
  phgValues,
} from '../dist/index.js';
// The neutral form and the byte helpers are not public API: the dump tool reads them from dist.
import { encodeUtf8, hexToBytes } from '../dist/bytes.js';
import { fromNeutralData, toNeutralData, toNeutralHeader } from '../dist/neutral.js';

const argv = process.argv.slice(2);
const mode = argv.includes('--encode') ? 'encode' : argv.includes('--build') ? 'build' : 'decode';
const limitAt = argv.indexOf('--limit');
const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : Infinity;
const [input, output] = argv.filter((a, i) => !a.startsWith('--') && !(limitAt >= 0 && i === limitAt + 1));
if (!input || !output) {
  console.error('usage: node scripts/diff-dump.mjs [--encode|--build] <in.gz> <out.jsonl.gz> [--limit N]');
  process.exit(2);
}

// ---- shared

function numberEqual(a, b) {
  if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * (scale >= 1 ? scale : 1);
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return numberEqual(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && same(a[k], b[k]));
  }
  return a === b;
}

/** Bytes as lower-case hex, as the README's records write them. */
function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A line decoded leniently, in the neutral form: with the header, or just data and diagnostics. */
function decodedAgain(line, withHeader) {
  try {
    const packet = decodeTnc2(line, ParseOptions.lenient);
    const out = withHeader ? { header: toNeutralHeader(packet) } : {};
    out.data = toNeutralData(packet.data);
    out.diagnostics = packet.diagnostics.map(formatDiagnostic);
    return out;
  } catch (e) {
    if (e instanceof AprsHeaderError) return { header_error: e.diagnostics.map(formatDiagnostic) };
    throw e;
  }
}

/** An encoder refusal, or a builder declining a value (a symbol it cannot make, say). */
function refusalCode(e) {
  // A RangeError is the builder's symbol constructor declining a symbol.
  return e instanceof AprsEncodeError ? e.code : 'invalid-symbol';
}

function isRefusal(e) {
  return e instanceof AprsEncodeError || e instanceof RangeError;
}

// ---- decode

function result(bytes, options) {
  try {
    const packet = decodeTnc2(bytes, options);
    return {
      packet,
      json: {
        header: toNeutralHeader(packet),
        data: toNeutralData(packet.data),
        diagnostics: packet.diagnostics.map(formatDiagnostic),
      },
    };
  } catch (e) {
    if (e instanceof AprsHeaderError) return { json: { header_error: e.diagnostics.map(formatDiagnostic) } };
    throw e;
  }
}

function sentInfo(packet) {
  let end = packet.information.length;
  while (end > 0 && (packet.information[end - 1] === 0x0d || packet.information[end - 1] === 0x0a)) end--;
  return packet.information.subarray(0, end);
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reencode(lenient) {
  const packet = lenient.packet;
  if (!packet || packet.data.type === 'unrecognized') return { how: 'none' };
  let encoded;
  try {
    encoded = encodeInformation(packet.data);
  } catch (e) {
    if (e instanceof AprsEncodeError) return { how: 'refused', refusal: e.code };
    throw e;
  }
  const written = { written: bytesToHex(encoded.information) };
  if (packet.data.type === 'mic-e') written.written_destination = encoded.destination;
  return { how: judge(lenient, packet, encoded), written };
}

function judge(lenient, packet, encoded) {
  const destination = encoded.destination ?? packet.destination;
  if (equalBytes(encoded.information, sentInfo(packet)) && (packet.data.type !== 'mic-e' || destination === packet.destination)) {
    return 'identical';
  }
  // Re-decode under a well-formed header, so that a defect in the original one (an empty
  // destination, say) is not counted against the encoder: for Mic-E the destination the encoder
  // computed, otherwise a normal one. The source decoded, so it is a valid address.
  const line = concat(encodeUtf8(`${packet.source}>${encoded.destination ?? 'APZ001'}:`), encoded.information);
  let again;
  try {
    again = decodeTnc2(line, ParseOptions.lenient);
  } catch {
    return 'fails';
  }
  if (again.diagnostics.some((d) => d.severity !== 'info')) return 'fails';
  return same(toNeutralData(again.data), lenient.json.data) ? 'equivalent' : 'fails';
}

/** The data's symbol, for the kinds of data that have one. */
function symbolOfData(data) {
  switch (data.type) {
    case 'position':
    case 'mic-e':
    case 'object':
    case 'item':
    case 'status':
      return data.symbol;
    default:
      return undefined;
  }
}

/**
 * The API view (README "The API view"): what the packet's own accessors and the library's
 * functions give, read as a program would. aprs-ts writes the keys its API offers: it has no
 * accessor saying a packet came from inside a third-party one, so third_party is left out.
 */
function apiView(packet) {
  const api = {
    source: packet.source,
    destination: packet.destination,
    path: packet.path.map((e) => (e.used ? `${e.address}*` : e.address)),
  };
  if (packet.qConstruct) {
    const q = { construct: packet.qConstruct.construct };
    if (packet.qConstruct.station !== undefined) q.station = packet.qConstruct.station;
    api.q_construct = q;
  } else {
    api.q_construct = null;
  }
  api.has_errors = hasErrors(packet);
  api.has_warnings = hasWarnings(packet);
  api.tnc2 = bytesToHex(packetToTnc2Bytes(packet));
  try {
    api.ax25 = bytesToHex(packetToAx25(packet));
  } catch (e) {
    if (!(e instanceof AprsEncodeError)) throw e;
    api.ax25 = 'refused';
    api.ax25_refusal = e.code;
  }
  if (packet.device) {
    const device = {};
    for (const key of ['vendor', 'model', 'class']) if (packet.device[key] !== undefined) device[key] = packet.device[key];
    api.device = device;
  } else {
    api.device = null;
  }
  const symbol = symbolOfData(packet.data);
  if (symbol) api.symbol = { description: describeSymbol(symbol) ?? null };
  if (packet.data.phg) {
    const v = phgValues(packet.data.phg);
    api.phg = { watts: v.powerWatts, height_feet: v.heightFeet, gain_db: v.gainDb, directivity_degrees: v.directivityDegrees };
  }
  if (packet.data.type === 'third-party') api.inner = apiView(packet.data.packet);
  return api;
}

function decodeRecord(n, line) {
  const bytes = hexToBytes(line.trim());
  const lenient = result(bytes, ParseOptions.lenient);
  const strict = result(bytes, ParseOptions.strict);
  const { how, written, refusal } = reencode(lenient);
  const record = { n, lenient: lenient.json, strict: strict.json, reencode: how, ...written };
  if (refusal !== undefined) record.reencode_refusal = refusal;
  if (lenient.packet) record.api = apiView(lenient.packet);
  return record;
}

// ---- encode

/** The keys `a` holds that `b` does not, as paths: what a conversion lost. */
function lostKeys(a, b, path, out) {
  if (Array.isArray(a)) {
    if (Array.isArray(b)) a.forEach((x, i) => lostKeys(x, b[i], `${path}[${i}]`, out));
  } else if (a && typeof a === 'object') {
    for (const k of Object.keys(a)) {
      const p = path ? `${path}.${k}` : k;
      if (!b || typeof b !== 'object' || !(k in b)) out.push(p);
      else lostKeys(a[k], b[k], p, out);
    }
  }
  return out;
}

function encodeRecord(n, line) {
  const { data } = JSON.parse(line);
  let own;
  try {
    own = fromNeutralData(data);
  } catch (e) {
    if (e instanceof RangeError) return { n, result: 'unsupported', reason: e.message };
    throw e;
  }
  // Anything the data form holds that aprs-ts's data does not is unsupported, not silently dropped.
  // An ack or reject with a message ID of its own, and a capabilities report with no items, are
  // data the encoder refuses, not data aprs-ts lacks.
  const refusable = (k) => (k === 'message_id' && (data.type === 'ack' || data.type === 'reject')) || (k === 'capabilities' && data.type === 'capabilities');
  const lost = lostKeys(data, toNeutralData(own), '', []).filter((k) => !refusable(k));
  if (lost.length > 0) return { n, result: 'unsupported', reason: `aprs-ts data has no ${lost.join(', ')}` };
  let encoded;
  try {
    encoded = encodeInformation(own);
  } catch (e) {
    if (e instanceof AprsEncodeError) return { n, result: 'refused', reason: e.message, refusal: e.code };
    throw e;
  }
  const destination = encoded.destination ?? 'APZ001';
  const again = decodedAgain(concat(encodeUtf8(`N0CALL>${destination}:`), encoded.information), false);
  return { n, result: 'written', info: bytesToHex(encoded.information), destination, again };
}

// ---- build

class Unsupported extends Error {}

function unsupported(key, why) {
  throw new Unsupported(`${key}: ${why}`);
}

/** Checks every key of `args` is one the builder can express for this report. */
function checkKeys(args, known, report) {
  for (const key of Object.keys(args)) {
    if (!known.has(key)) unsupported(key, `the aprs-ts builder has no way to give it for a ${report}`);
  }
}

const POSITIONED_OPTIONS = [
  'symbol',
  'course_degrees',
  'speed_knots',
  'speed_kmh',
  'altitude_feet',
  'altitude_m',
  'comment',
  'frequency',
  'ambiguity',
  'dao',
  'telemetry',
];
const REPORT_OPTIONS = [...POSITIONED_OPTIONS, 'phg', 'range_miles', 'compressed'];

const WEATHER_VALUES = {
  wind_direction_degrees: 'windDirectionDegrees',
  wind_speed_mph: 'windSpeedMph',
  wind_gust_mph: 'windGustMph',
  temperature_f: 'temperatureF',
  rain_1h_in: 'rain1hIn',
  rain_24h_in: 'rain24hIn',
  rain_midnight_in: 'rainMidnightIn',
  humidity_percent: 'humidityPercent',
  pressure_mbar: 'pressureMbar',
  luminosity_w_m2: 'luminosityWM2',
  snow_24h_in: 'snow24hIn',
  temperature_c: 'temperatureC',
  rain_1h_mm: 'rain1hMm',
  rain_24h_mm: 'rain24hMm',
  rain_midnight_mm: 'rainMidnightMm',
};
/** Recipe keys the builder takes in another unit beside the APRS one: given both, unsupported. */
const WEATHER_PAIRS = [
  ['temperature_c', 'temperature_f'],
  ['rain_1h_mm', 'rain_1h_in'],
  ['rain_24h_mm', 'rain_24h_in'],
  ['rain_midnight_mm', 'rain_midnight_in'],
];

/** A recipe timestamp as the builder takes it: a Date and the form to write. */
function when(t) {
  if (!t || typeof t.utc !== 'string') unsupported('timestamp', 'it has no utc time');
  const date = new Date(t.utc);
  if (Number.isNaN(date.getTime())) unsupported('timestamp', `${t.utc} is not a time`);
  return { date, format: t.format };
}

/** A position or object timestamp: `dhm` or `hms`. */
function reportTimestamp(t) {
  const { date, format } = when(t);
  if (format === 'dhm') return { date, kind: 'dhm-zulu' };
  if (format === 'hms') return { date, kind: 'hms' };
  return unsupported('timestamp', `the builder writes a ${format} timestamp only on a positionless weather report`);
}

/** The positioned options, on a position, object, item or Mic-E builder. */
function positioned(b, args, report) {
  if (args.symbol !== undefined) b.symbol(args.symbol);
  if (args.course_degrees !== undefined) b.courseDegrees(args.course_degrees);
  if (args.speed_knots !== undefined && args.speed_kmh !== undefined) unsupported('speed_kmh', 'given with speed_knots');
  if (args.speed_knots !== undefined) b.speedKnots(args.speed_knots);
  if (args.speed_kmh !== undefined) b.speedKmh(args.speed_kmh);
  if (args.altitude_feet !== undefined) b.altitudeFeet(args.altitude_feet);
  if (args.altitude_m !== undefined) b.altitudeM(args.altitude_m);
  if (args.comment !== undefined) b.comment(args.comment);
  if (args.frequency !== undefined) {
    const f = args.frequency;
    for (const key of Object.keys(f)) {
      if (!['mhz', 'tone', 'tone_value', 'offset_khz'].includes(key)) unsupported(`frequency.${key}`, 'not a recipe key');
    }
    const details = {};
    if (f.tone !== undefined) details.tone = f.tone;
    if (f.tone_value !== undefined) details.toneValue = f.tone_value;
    if (f.offset_khz !== undefined) details.offsetKhz = f.offset_khz;
    b.frequency(f.mhz, details);
  }
  if (args.ambiguity !== undefined) b.ambiguity(args.ambiguity);
  if (args.dao === true) b.dao();
  if (args.telemetry !== undefined) b.telemetry(args.telemetry.sequence, args.telemetry.analog, args.telemetry.digital);
  if (report !== 'mic-e') {
    if (args.phg !== undefined) b.phg(args.phg.power, args.phg.height, args.phg.gain, args.phg.directivity, args.phg.beacons_per_hour);
    if (args.range_miles !== undefined) b.rangeMiles(args.range_miles);
    if (args.compressed === true) b.compressed();
  }
  return b;
}

function weatherOf(args) {
  for (const [metric, aprs] of WEATHER_PAIRS) {
    if (args[metric] !== undefined && args[aprs] !== undefined) unsupported(metric, `given with ${aprs}`);
  }
  const w = {};
  for (const [key, field] of Object.entries(WEATHER_VALUES)) if (args[key] !== undefined) w[field] = args[key];
  return w;
}

function builderFor(recipe) {
  const { station, report, args } = recipe;
  for (const key of Object.keys(station)) {
    if (!['source', 'destination', 'path'].includes(key)) unsupported(`station.${key}`, 'not a station key');
  }
  let p = Aprs.from(station.source);
  if (station.destination !== undefined) p = p.to(station.destination);
  if (station.path !== undefined && station.path.length > 0) p = p.via(...station.path);
  const a = args;
  switch (report) {
    case 'position': {
      checkKeys(a, new Set(['latitude', 'longitude', 'messaging', 'timestamp', ...REPORT_OPTIONS]), report);
      const b = positioned(p.position(a.latitude, a.longitude), a, report);
      if (a.messaging === true) b.messaging();
      if (a.timestamp !== undefined) {
        const t = reportTimestamp(a.timestamp);
        b.timestamp(t.date, t.kind);
      }
      return b;
    }
    case 'object': {
      checkKeys(a, new Set(['name', 'latitude', 'longitude', 'timestamp', 'killed', ...REPORT_OPTIONS]), report);
      const b = positioned(p.object(a.name, a.latitude, a.longitude), a, report);
      // An object always has a timestamp; the builder's default is the clock, so a recipe gives one.
      if (a.timestamp === undefined) unsupported('timestamp', 'an object needs one, and the builder would take the clock');
      const t = reportTimestamp(a.timestamp);
      b.timestamp(t.date, t.kind);
      if (a.killed === true) b.killed();
      return b;
    }
    case 'item': {
      checkKeys(a, new Set(['name', 'latitude', 'longitude', 'killed', ...REPORT_OPTIONS]), report);
      const b = positioned(p.item(a.name, a.latitude, a.longitude), a, report);
      if (a.killed === true) b.killed();
      return b;
    }
    case 'mic-e': {
      checkKeys(a, new Set(['latitude', 'longitude', 'mic_e_message', 'messaging', ...POSITIONED_OPTIONS]), report);
      const b = positioned(p.micE(a.latitude, a.longitude), a, report);
      if (a.mic_e_message !== undefined) b.micEMessage(a.mic_e_message);
      // The type code says whether the sender takes messages: ` if so, ' if not.
      b.messaging(a.messaging === true);
      return b;
    }
    case 'weather': {
      const known = new Set(['latitude', 'longitude', 'symbol', 'timestamp', ...Object.keys(WEATHER_VALUES)]);
      checkKeys(a, known, report);
      const w = weatherOf(a);
      if (a.latitude !== undefined || a.longitude !== undefined) {
        const b = p.weather(w, { latitude: a.latitude, longitude: a.longitude });
        if (a.symbol !== undefined) b.symbol(a.symbol);
        if (a.timestamp !== undefined) {
          const t = reportTimestamp(a.timestamp);
          b.timestamp(t.date, t.kind);
        }
        return b;
      }
      if (a.symbol !== undefined) unsupported('symbol', 'a positionless weather report has no symbol');
      if (a.timestamp === undefined) unsupported('timestamp', 'a positionless weather report needs one, and the builder would take the clock');
      const { date, format } = when(a.timestamp);
      if (format !== 'mdhm') unsupported('timestamp', `a positionless weather report's timestamp is mdhm, not ${format}`);
      return p.weather(w, { at: date });
    }
    case 'message': {
      checkKeys(a, new Set(['addressee', 'text', 'message_id', 'reply_ack']), report);
      const b = p.message(a.addressee, a.text);
      if (a.message_id !== undefined) b.messageId(a.message_id);
      if (a.reply_ack !== undefined) b.replyAck(a.reply_ack);
      return b;
    }
    case 'ack':
    case 'reject':
      checkKeys(a, new Set(['addressee', 'message_id']), report);
      return report === 'ack' ? p.ack(a.addressee, a.message_id) : p.reject(a.addressee, a.message_id);
    case 'bulletin':
      checkKeys(a, new Set(['id', 'group', 'text']), report);
      return p.bulletin(a.id, a.text, a.group ?? '');
    case 'status': {
      checkKeys(a, new Set(['text', 'timestamp', 'locator', 'symbol', 'beam']), report);
      const b = p.status(a.text);
      if (a.timestamp !== undefined) {
        const { date, format } = when(a.timestamp);
        if (format !== 'dhm') unsupported('timestamp', `a status timestamp is dhm, not ${format}`);
        b.timestamp(date);
      }
      if (a.locator !== undefined || a.symbol !== undefined) {
        if (a.locator === undefined) unsupported('symbol', 'the builder takes a status symbol only with a locator');
        if (a.symbol === undefined) unsupported('locator', 'the builder takes a status locator only with a symbol');
        b.locator(a.locator, a.symbol);
      }
      if (a.beam !== undefined) b.beam(a.beam.heading_code, a.beam.power_code);
      return b;
    }
    case 'telemetry': {
      checkKeys(a, new Set(['sequence', 'analog', 'bits', 'comment']), report);
      const b = p.telemetry(a.sequence, a.analog, a.bits);
      if (a.comment !== undefined) b.comment(a.comment);
      return b;
    }
    case 'telemetry-names':
      checkKeys(a, new Set(['names', 'addressee']), report);
      return p.telemetryNames(a.names, a.addressee);
    case 'telemetry-units':
      checkKeys(a, new Set(['units', 'addressee']), report);
      return p.telemetryUnits(a.units, a.addressee);
    case 'telemetry-coefficients':
      checkKeys(a, new Set(['coefficients', 'addressee']), report);
      return p.telemetryCoefficients(a.coefficients, a.addressee);
    case 'telemetry-bits':
      checkKeys(a, new Set(['bits', 'project', 'addressee']), report);
      return p.telemetryBits(a.bits, a.project, a.addressee);
    default:
      return unsupported('report', `the aprs-ts builder has no ${report} report`);
  }
}

function buildRecord(n, line) {
  const recipe = JSON.parse(line);
  let packet;
  try {
    packet = builderFor(recipe).build();
  } catch (e) {
    if (e instanceof Unsupported) return { n, result: 'unsupported', reason: e.message };
    if (isRefusal(e)) return { n, result: 'refused', reason: e.message, refusal: refusalCode(e) };
    throw e;
  }
  const tnc2 = packet.toTnc2Bytes();
  return { n, result: 'built', tnc2: bytesToHex(tnc2), again: decodedAgain(tnc2, true) };
}

// ---- the loop

const record = mode === 'encode' ? encodeRecord : mode === 'build' ? buildRecord : decodeRecord;
const gzip = createGzip();
const out = createWriteStream(output);
gzip.pipe(out);
const lines = createInterface({ input: createReadStream(input).pipe(createGunzip()), crlfDelay: Infinity });
let n = 0;
const started = Date.now();
for await (const line of lines) {
  if (n >= limit) break;
  if (!gzip.write(JSON.stringify(record(n, line)) + '\n')) await new Promise((r) => gzip.once('drain', r));
  n++;
  if (n % 500000 === 0) console.error(`${n.toLocaleString('en-GB')} lines, ${Math.round((Date.now() - started) / 1000)} s`);
}
gzip.end();
await new Promise((r) => out.once('finish', r));
console.error(`${output}: ${n.toLocaleString('en-GB')} ${mode} records in ${Math.round((Date.now() - started) / 1000)} s`);
