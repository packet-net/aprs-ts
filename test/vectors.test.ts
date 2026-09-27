// Runs every case in the conformance vectors (the vectors submodule) with every check its README
// defines: one test per check per case, named after the case id and the check.
//
//   lenient    the default decoder's result
//   strict     the strict decoder's result (same, a rejection, or a different reading)
//   tolerance  with only the one tolerance a case used turned off, the strict result
//   reencode   encoding the lenient data again: identical, equivalent, or refused
//   encode     an encode case: the information field (and Mic-E destination), or a refusal
//
// Checks listed in known-differences.json are skipped, with the reason in the test name.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AprsEncodeError,
  decodeTnc2,
  encodeUtf8,
  encodeInformation,
  formatDiagnostic,
  fromNeutralData,
  ParseOptions,
  toNeutralData,
  type AprsPacket,
} from '../src/index.js';
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
  let encoded: { info: Uint8Array; destination?: string };
  try {
    encoded = encodeInformation(packet.data);
  } catch (e) {
    if (e instanceof AprsEncodeError) {
      return c.reencode === 'refused' ? [] : [`the encoder refused: ${e.message}`];
    }
    throw e;
  }
  if (c.reencode === 'refused') return [`expected a refusal, wrote ${JSON.stringify(latin1(encoded.info))}`];
  const destination = encoded.destination ?? packet.destination;
  if (c.reencode === 'identical') {
    const problems: string[] = [];
    const want = sentInfo(packet);
    if (hex(want) !== hex(encoded.info))
      problems.push(`wrote ${JSON.stringify(latin1(encoded.info))}, sent ${JSON.stringify(latin1(want))}`);
    if (packet.data.type === 'mic-e' && destination !== packet.destination)
      problems.push(`destination ${destination}, sent ${packet.destination}`);
    return problems;
  }
  // equivalent: decodes, leniently, to the same data with no warnings or errors, under a
  // well-formed header (for Mic-E, the destination the encoder computed), so that a defect in the
  // original header is not counted against the encoder.
  const header = encodeUtf8(`${packet.source}>${encoded.destination ?? 'APZ001'}:`);
  const line = new Uint8Array(header.length + encoded.info.length);
  line.set(header, 0);
  line.set(encoded.info, header.length);
  const again = decodeTnc2(line, ParseOptions.lenient);
  const problems = differences(toNeutralData(again.data), lenient.data, 'data');
  const bad = again.diagnostics.map(formatDiagnostic).filter((d) => !d.startsWith('info:'));
  if (bad.length > 0) problems.push(`re-decoding reported ${bad.join(', ')}`);
  if (problems.length > 0) problems.push(`wrote ${JSON.stringify(latin1(encoded.info))}`);
  return problems;
}

function encodeCheck(c: Case): string[] {
  const data = fromNeutralData(c.input.encode);
  let encoded: { info: Uint8Array; destination?: string };
  try {
    encoded = encodeInformation(data);
  } catch (e) {
    if (e instanceof AprsEncodeError) return c.expect.refused ? [] : [`the encoder refused: ${e.message}`];
    throw e;
  }
  if (c.expect.refused) return [`expected a refusal, wrote ${JSON.stringify(latin1(encoded.info))}`];
  const problems: string[] = [];
  const want = encodeUtf8(c.expect.info as string);
  if (hex(want) !== hex(encoded.info)) problems.push(`wrote ${JSON.stringify(latin1(encoded.info))}, want ${JSON.stringify(latin1(want))}`);
  if (c.expect.destination !== undefined && encoded.destination !== c.expect.destination)
    problems.push(`destination ${encoded.destination}, want ${c.expect.destination}`);
  return problems;
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
