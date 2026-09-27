// Differential dump: decodes every line of a capture and writes one JSON object per line in the
// form aprs-vectors' tools/compare.py reads (see its README, "Comparing two implementations"):
//
//   {"n": 0, "lenient": R, "strict": R, "reencode": "identical|equivalent|refused|fails|none"}
//
// where R is {"header", "data", "diagnostics"} in the neutral form, or {"header_error": [...]}.
//
//   npm run build
//   node scripts/diff-dump.mjs lines.hex.gz ts.jsonl.gz [--limit N]
//
// The lines file has one hex-encoded TNC2 line per line, gzip compressed.

import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import {
  AprsEncodeError,
  AprsHeaderError,
  decodeTnc2,
  encodeInformation,
  formatDiagnostic,
  hexToBytes,
  ParseOptions,
  toNeutralData,
  toNeutralHeader,
} from '../dist/index.js';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/diff-dump.mjs <lines.hex.gz> <out.jsonl.gz> [--limit N]');
  process.exit(2);
}
const limitAt = rest.indexOf('--limit');
const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : Infinity;

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
  if (!packet || packet.data.type === 'unrecognized') return 'none';
  let encoded;
  try {
    encoded = encodeInformation(packet.data);
  } catch (e) {
    if (e instanceof AprsEncodeError) return 'refused';
    throw e;
  }
  const destination = encoded.destination ?? packet.destination;
  if (equalBytes(encoded.info, sentInfo(packet)) && (packet.data.type !== 'mic-e' || destination === packet.destination)) {
    return 'identical';
  }
  // Re-decode under a well-formed header, so that a defect in the original one (an empty
  // destination, say) is not counted against the encoder: for Mic-E the destination the encoder
  // computed, otherwise a normal one. The source decoded, so it is a valid address.
  const header = new TextEncoder().encode(`${packet.source}>${encoded.destination ?? 'APZ001'}:`);
  const line = new Uint8Array(header.length + encoded.info.length);
  line.set(header, 0);
  line.set(encoded.info, header.length);
  let again;
  try {
    again = decodeTnc2(line, ParseOptions.lenient);
  } catch {
    return 'fails';
  }
  if (again.diagnostics.some((d) => d.severity !== 'info')) return 'fails';
  return same(toNeutralData(again.data), lenient.json.data) ? 'equivalent' : 'fails';
}

const gzip = createGzip();
const out = createWriteStream(output);
gzip.pipe(out);
const lines = createInterface({ input: createReadStream(input).pipe(createGunzip()), crlfDelay: Infinity });
let n = 0;
const started = Date.now();
for await (const line of lines) {
  if (n >= limit) break;
  const bytes = hexToBytes(line.trim());
  const lenient = result(bytes, ParseOptions.lenient);
  const strict = result(bytes, ParseOptions.strict);
  const record = { n, lenient: lenient.json, strict: strict.json, reencode: reencode(lenient) };
  if (!gzip.write(JSON.stringify(record) + '\n')) await new Promise((r) => gzip.once('drain', r));
  n++;
  if (n % 500000 === 0) console.error(`${n.toLocaleString('en-GB')} packets, ${Math.round((Date.now() - started) / 1000)} s`);
}
gzip.end();
await new Promise((r) => out.once('finish', r));
console.error(`${output}: ${n.toLocaleString('en-GB')} packets in ${Math.round((Date.now() - started) / 1000)} s`);
