// Runs every case in the conformance vectors (the vectors submodule) with every check its README
// defines: one test per check per case, named after the case id and the check.
//
//   lenient    the default decoder's result
//   strict     the strict decoder's result (same, a rejection, or a different reading)
//   tolerance  with only the one tolerance a case used turned off, the strict result
//   reencode   encoding the lenient data again: identical, equivalent (and then canonical_info
//              byte for byte), rounded (canonical_info byte for byte), or refused
//   encode     an encode case: the information field (and Mic-E destination), or a refusal
//   build      a build case: the TNC2 line the builder makes from a recipe, or a refusal; the
//              builder is called as the dump tool's build mode calls it (scripts/recipe.mjs)
//
// Checks listed in known-differences.json are skipped, with the reason in the test name.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Aprs,
  AprsEncodeError,
  decodeTnc2,
  encodeInformation,
  formatDiagnostic,
  ParseOptions,
  type AprsPacket,
} from '../src/index.js';
import { encodeUtf8, hexToBytes } from '../src/bytes.js';
import { refusalRank } from '../src/encode/common.js';
import { recipeBuilder } from '../scripts/recipe.mjs';
import { fromNeutralData, toNeutralData } from '../src/neutral.js';
import {
  checkStrict,
  compareResult,
  decode,
  decodeInput,
  differences,
  loadCases,
  loadTolerable,
  singleTolerance,
  type Case,
  type Result,
} from './harness.js';

interface KnownDifference {
  id: string;
  check: string;
  reason: string;
}

const known: KnownDifference[] = JSON.parse(readFileSync(new URL('./known-differences.json', import.meta.url), 'utf8')).differences;
const knownReason = (id: string, check: string): string | undefined => known.find((k) => k.id === id && k.check === check)?.reason;
const tolerable = loadTolerable();

function check(id: string, name: string, body: () => void): void {
  const reason = knownReason(id, name);
  if (reason !== undefined) it.skip(`${id} ${name} (known difference: ${reason})`, body);
  else it(`${id} ${name}`, body);
}

function fail(problems: string[]): void {
  expect(problems, problems.join('\n')).toEqual([]);
}

/** The information field bytes as sent, without a trailing CR or LF. */
function sentInfo(packet: AprsPacket): Uint8Array {
  let end = packet.information.length;
  while (end > 0 && (packet.information[end - 1] === 0x0d || packet.information[end - 1] === 0x0a)) end--;
  return packet.information.subarray(0, end);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

function reencodeCheck(c: Case, lenient: Result): string[] {
  if ('header_error' in lenient) return ['the lenient decoder rejected the header'];
  const packet = lenient.packet;
  let encoded: { information: Uint8Array; destination?: string };
  try {
    encoded = encodeInformation(packet.data);
  } catch (e) {
    if (e instanceof AprsEncodeError) {
      if (c.reencode !== 'refused') return [`the encoder refused: ${e.message}`];
      const want = (c as { reencode_refusal?: string }).reencode_refusal;
      return want === undefined || want === e.code ? [] : [`refused with ${e.code} (${e.message}), want ${want}`];
    }
    throw e;
  }
  if (c.reencode === 'refused') return [`expected a refusal, wrote ${JSON.stringify(latin1(encoded.information))}`];
  // rounded: a value the format holds only in steps is rounded, so the data read back differs from
  // the original by that rounding and is not compared; the bytes are exactly canonical_info.
  if (c.reencode === 'rounded') return canonicalCheck(c, encoded.information, true);
  const destination = encoded.destination ?? packet.destination;
  if (c.reencode === 'identical') {
    const problems: string[] = [];
    const want = sentInfo(packet);
    if (hex(want) !== hex(encoded.information))
      problems.push(`wrote ${JSON.stringify(latin1(encoded.information))}, sent ${JSON.stringify(latin1(want))}`);
    if (packet.data.type === 'mic-e' && destination !== packet.destination)
      problems.push(`destination ${destination}, sent ${packet.destination}`);
    return problems;
  }
  // equivalent: decodes, leniently, to the same data with no warnings or errors, under a
  // well-formed header (for Mic-E, the destination the encoder computed), so that a defect in the
  // original header is not counted against the encoder.
  const header = encodeUtf8(`${packet.source}>${encoded.destination ?? 'APZ001'}:`);
  const line = new Uint8Array(header.length + encoded.information.length);
  line.set(header, 0);
  line.set(encoded.information, header.length);
  const again = decodeTnc2(line, ParseOptions.lenient);
  const problems = differences(toNeutralData(again.data), lenient.data, 'data');
  const bad = again.diagnostics.map(formatDiagnostic).filter((d) => !d.startsWith('info:'));
  if (bad.length > 0) problems.push(`re-decoding reported ${bad.join(', ')}`);
  if (problems.length > 0) problems.push(`wrote ${JSON.stringify(latin1(encoded.information))}`);
  else problems.push(...canonicalCheck(c, encoded.information, false));
  return problems;
}

/**
 * The bytes written against the case's canonical_info, byte for byte: binding for `equivalent`
 * (when the case gives one) and for `rounded` (which always does).
 */
function canonicalCheck(c: Case, written: Uint8Array, required: boolean): string[] {
  let want: Uint8Array;
  if (typeof c.canonical_info === 'string') want = encodeUtf8(c.canonical_info);
  else if (typeof c.canonical_info_hex === 'string') want = hexToBytes(c.canonical_info_hex);
  else return required ? ['the case gives no canonical_info'] : [];
  return hex(want) === hex(written) ? [] : [`wrote ${JSON.stringify(latin1(written))}, canonical ${JSON.stringify(latin1(want))}`];
}

function encodeCheck(c: Case): string[] {
  const data = fromNeutralData(c.input.encode);
  let encoded: { information: Uint8Array; destination?: string };
  try {
    encoded = encodeInformation(data);
  } catch (e) {
    if (e instanceof AprsEncodeError) {
      if (!c.expect.refused) return [`the encoder refused: ${e.message}`];
      const want = c.expect.refusal as string | undefined;
      return want === undefined || want === e.code ? [] : [`refused with ${e.code} (${e.message}), want ${want}`];
    }
    throw e;
  }
  if (c.expect.refused) return [`expected a refusal, wrote ${JSON.stringify(latin1(encoded.information))}`];
  const problems: string[] = [];
  const want = encodeUtf8(c.expect.info as string);
  if (hex(want) !== hex(encoded.information)) problems.push(`wrote ${JSON.stringify(latin1(encoded.information))}, want ${JSON.stringify(latin1(want))}`);
  if (c.expect.destination !== undefined && encoded.destination !== c.expect.destination)
    problems.push(`destination ${encoded.destination}, want ${c.expect.destination}`);
  return problems;
}

// The recipe mapping the dump tool's build mode uses, run against the sources.
const { buildRecipe } = recipeBuilder({ Aprs, AprsEncodeError, refusalRank });

function buildCheck(c: Case): string[] {
  const r = buildRecipe(0, c.input.build);
  if (r.result === 'unsupported') return [`the recipe is unsupported: ${r.reason}`];
  if (r.result === 'refused') {
    if (!c.expect.refused) return [`the builder refused (${r.refusal}): ${r.reason}`];
    const want = c.expect.refusal as string | undefined;
    return want === undefined || want === r.refusal ? [] : [`refused with ${r.refusal} (${r.reason}), want ${want}`];
  }
  if (c.expect.refused) return [`expected a refusal, built ${JSON.stringify(latin1(r.bytes))}`];
  const want = c.expect.tnc2_hex !== undefined ? hexToBytes(c.expect.tnc2_hex as string) : encodeUtf8(c.expect.tnc2 as string);
  return hex(want) === hex(r.bytes) ? [] : [`built ${JSON.stringify(latin1(r.bytes))}, want ${JSON.stringify(latin1(want))}`];
}

// A case without `device` says nothing about device identification (vectors README, "Rules the
// cases rely on"), so only a recorded one is checked.
function deviceCheck(c: Case, lenient: Result): string[] {
  if ('header_error' in lenient || c.expect.device === undefined) return [];
  const device = lenient.packet.device;
  const got: Record<string, string> = {};
  if (device?.vendor !== undefined) got.vendor = device.vendor;
  if (device?.model !== undefined) got.model = device.model;
  return differences(got, c.expect.device, 'device');
}

for (const { file, cases } of loadCases()) {
  describe(file, () => {
    for (const c of cases) {
      if (c.input.encode !== undefined) {
        check(c.id, 'encode', () => fail(encodeCheck(c)));
        continue;
      }
      if (c.input.build !== undefined) {
        check(c.id, 'build', () => fail(buildCheck(c)));
        continue;
      }
      const input = decodeInput(c.input);
      check(c.id, 'lenient', () => {
        const lenient = decode(input, ParseOptions.lenient);
        fail([...compareResult(lenient, c.expect), ...deviceCheck(c, lenient)]);
      });
      check(c.id, 'strict', () => fail(checkStrict(decode(input, ParseOptions.strict), c)));
      const code = singleTolerance(c, tolerable);
      if (code !== undefined) {
        check(c.id, 'tolerance', () => fail(checkStrict(decode(input, ParseOptions.lenient.without(code)), c)));
      }
      if (c.reencode !== undefined) {
        check(c.id, 'reencode', () => fail(reencodeCheck(c, decode(input, ParseOptions.lenient))));
      }
    }
  });
}
