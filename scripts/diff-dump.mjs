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
// build: a builder recipe per line, of which only the keys the recipe gives are passed on (an
// absent one is never filled in, so the builder's own defaults show); writes
//   {"n", "result": "built|refused|unsupported", "tnc2", "again", "reason", "refusal"}
//
// This library has no fixed capacity, so it never writes the `implementation-limit` result or
// diagnostic that the README gives a library that has one.

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
import { refusalRank } from '../dist/encode/common.js';
import { recipeBuilder } from './recipe.mjs';

/**
 * JSON that may hold the non-standard tokens NaN, Infinity and -Infinity, which generate.py
 * writes with --nonfinite: they are read as numbers, outside strings only.
 */
function parseJson(line) {
  if (!/NaN|Infinity/.test(line)) return JSON.parse(line);
  const MARK = '\u0000nonfinite:';
  let out = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      out += c;
      if (c === '\\') out += line[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    const token = ['-Infinity', 'Infinity', 'NaN'].find((t) => line.startsWith(t, i));
    if (token) {
      out += JSON.stringify(MARK + token);
      i += token.length - 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out, (_k, v) => (typeof v === 'string' && v.startsWith(MARK) ? Number(v.slice(MARK.length)) : v));
}

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

/**
 * The keys `a` holds that `b` does not, as paths: what a conversion lost. Walked with a stack, and
 * a path is spelled out only for a key lost, so data nested thousands deep costs no recursion.
 */
function lostKeys(a, b, out) {
  const spell = (node) => {
    const parts = [];
    for (let n = node; n.parent; n = n.parent) parts.push(n.key);
    return parts.reverse().reduce((p, k) => (typeof k === 'number' ? `${p}[${k}]` : p ? `${p}.${k}` : k), '');
  };
  const stack = [{ a, b, parent: undefined, key: undefined }];
  while (stack.length > 0) {
    const node = stack.pop();
    const { a: x, b: y } = node;
    if (Array.isArray(x)) {
      if (Array.isArray(y)) x.forEach((v, i) => stack.push({ a: v, b: y[i], parent: node, key: i }));
    } else if (x && typeof x === 'object') {
      for (const k of Object.keys(x)) {
        // An ack or reject with a message ID of its own, a telemetry report with no analog values
        // and a capabilities report with no items are data the encoder refuses, not data aprs-ts
        // lacks.
        if (k === 'message_id' && (x.type === 'ack' || x.type === 'reject')) continue;
        if (k === 'analog' && x.type === 'telemetry' && Array.isArray(x[k]) && x[k].length === 0) continue;
        if (k === 'capabilities' && x.type === 'capabilities' && Array.isArray(x[k]) && x[k].length === 0) continue;
        const child = { a: x[k], b: y?.[k], parent: node, key: k };
        if (!y || typeof y !== 'object' || !(k in y)) out.push(spell(child));
        else stack.push(child);
      }
    }
  }
  return out;
}

function encodeRecord(index, line) {
  const { n = index, data } = parseJson(line);
  let own;
  try {
    own = fromNeutralData(data);
  } catch (e) {
    if (e instanceof RangeError) return { n, result: 'unsupported', reason: e.message };
    throw e;
  }
  // Anything the data form holds that aprs-ts's data does not is unsupported, not silently dropped.
  const lost = lostKeys(data, toNeutralData(own), []);
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

const { buildRecipe } = recipeBuilder({ Aprs, AprsEncodeError, refusalRank });

function buildRecord(index, line) {
  const recipe = parseJson(line);
  const n = recipe.n ?? index;
  const r = buildRecipe(n, recipe);
  if (r.result !== 'built') return r;
  return { n, result: 'built', tnc2: bytesToHex(r.bytes), again: decodedAgain(r.bytes, true) };
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
