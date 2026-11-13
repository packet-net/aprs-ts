// What the encoder is given is checked for shape before anything reads it, so that data built by
// hand (and not checked by the type system) is refused with a reason, never with a TypeError.

import type { RefusalCode } from '../codes.js';
import type { AprsData } from '../types.js';
import { AprsEncodeError, refuse } from './common.js';

/** How many third-party packets may enclose one another (vectors interpretations.md). */
export const MAX_THIRD_PARTY_DEPTH = 4;

type Kind = 'string' | 'number' | 'array' | 'object' | 'bytes';

/** Fields a report always has, other than the text the absent-text rule covers. */
const REQUIRED: Readonly<Record<string, Readonly<Record<string, Kind>>>> = {
  position: { latitude: 'number', longitude: 'number' },
  object: { latitude: 'number', longitude: 'number' },
  item: { latitude: 'number', longitude: 'number' },
  'mic-e': { latitude: 'number', longitude: 'number', micEMessage: 'string' },
  message: { text: 'string' },
  ack: { ackedId: 'string' },
  reject: { rejectedId: 'string' },
  bulletin: { text: 'string' },
  'nws-bulletin': { text: 'string' },
  'telemetry-names': { names: 'array' },
  'telemetry-units': { units: 'array' },
  'telemetry-coefficients': { coefficients: 'array' },
  'telemetry-bits': { bits: 'string' },
  'directed-query': {},
  status: {},
  telemetry: { sequence: 'string', analog: 'array' },
  weather: { weather: 'object' },
  'raw-weather': { format: 'string' },
  nmea: { sentence: 'string' },
  'maidenhead-beacon': { locator: 'string' },
  query: {},
  capabilities: { capabilities: 'array' },
  'third-party': { packet: 'object' },
  'user-defined': { userId: 'string', packetType: 'string' },
  test: {},
  'agrelo-df': { bearingDegrees: 'number', quality: 'number' },
  unrecognized: {},
};

/** An inner packet's fields. */
const PACKET: Readonly<Record<string, Kind>> = {
  source: 'string',
  destination: 'string',
  path: 'array',
  information: 'bytes',
  data: 'object',
  diagnostics: 'array',
};

/** Text a report always has: left out, it is empty text (vectors interpretations.md, absent text is empty text). */
const TEXT: Readonly<Record<string, readonly string[]>> = {
  object: ['name'],
  item: ['name'],
  message: ['addressee'],
  ack: ['addressee'],
  reject: ['addressee'],
  bulletin: ['addressee'],
  'nws-bulletin': ['addressee'],
  'telemetry-names': ['addressee'],
  'telemetry-units': ['addressee'],
  'telemetry-coefficients': ['addressee'],
  'telemetry-bits': ['addressee'],
  'directed-query': ['addressee', 'queryType'],
  query: ['queryType'],
};

const POSITIONED = new Set(['position', 'object', 'item', 'mic-e']);

function isKind(v: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'bytes':
      return v instanceof Uint8Array;
  }
}

function checkFields(o: Record<string, unknown>, fields: Readonly<Record<string, Kind>>, what: string): void {
  for (const [k, kind] of Object.entries(fields)) {
    if (o[k] === undefined) refuse('missing-field', `${what} needs ${k}`);
    if (!isKind(o[k], kind)) refuse('malformed', `${what}: ${k} is not a ${kind}`);
  }
}

function isData(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Checks the data's shape and gives it back with absent text filled in as empty text. A missing
 * required field is `missing-field`, one of the wrong kind `malformed`, and third-party packets
 * nested more than four deep are `invalid-third-party-header`; the chain is walked without
 * recursion, so data nested thousands deep is refused, not a stack overflow.
 */
export function checkShape(data: unknown): AprsData {
  let level: unknown = data;
  let depth = 0;
  for (;;) {
    if (!isData(level)) refuse('missing-field', 'the data is not an object');
    if (level.type === undefined) refuse('missing-field', 'the data has no type');
    if (typeof level.type !== 'string' || !(level.type in REQUIRED)) refuse('not-encodable', `there is no data of type ${String(level.type)}`);
    if (level.type !== 'third-party') break;
    if (++depth > MAX_THIRD_PARTY_DEPTH) refuse('invalid-third-party-header', 'third-party packets nest at most four deep');
    const packet = level.packet;
    if (!isData(packet)) break;
    level = packet.data;
  }
  return normalise(data as Record<string, unknown>);
}

function normalise(d: Record<string, unknown>): AprsData {
  const type = d.type as string;
  checkFields(d, REQUIRED[type]!, type);
  let out: Record<string, unknown> = d;
  const fill = (k: string, v: unknown): void => {
    if (out === d) out = { ...d };
    out[k] = v;
  };
  for (const k of TEXT[type] ?? []) if (typeof d[k] !== 'string') fill(k, '');
  if (POSITIONED.has(type)) {
    const s = d.symbol;
    if (!isData(s) || typeof s.table !== 'string' || typeof s.code !== 'string') fill('symbol', { table: '', code: '' });
  }
  if (type === 'third-party') {
    const p = d.packet as Record<string, unknown>;
    checkFields(p, PACKET, 'a third-party packet');
    fill('packet', { ...p, data: normalise(p.data as Record<string, unknown>) });
  }
  return out as unknown as AprsData;
}

/**
 * Runs a public encoding step so that it can only fail with an `AprsEncodeError`: anything else
 * thrown on the way (a value of a kind the step cannot use, deep inside optional data) is refused
 * as `malformed`.
 */
export function guarded<T>(step: () => T, code: RefusalCode = 'malformed'): T {
  try {
    return step();
  } catch (e) {
    if (e instanceof AprsEncodeError) throw e;
    throw new AprsEncodeError(`the data is not of a shape this encoder can use: ${e instanceof Error ? e.message : String(e)}`, code);
  }
}
