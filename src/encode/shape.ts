// What the encoder is given is checked for shape before anything reads it, so that data built by
// hand (and not checked by the type system) is refused with a reason, never with a TypeError.

import type { RefusalCode } from '../codes.js';
import type { AprsData } from '../types.js';
import { AprsEncodeError, refuse } from './common.js';

/** How many third-party packets may enclose one another (vectors interpretations.md). */
export const MAX_THIRD_PARTY_DEPTH = 4;

type Kind = 'string' | 'number' | 'array' | 'object' | 'bytes';

/** A required field: its kind, and a stand-in that adds no fault of its own, or none when nothing can be checked without it. */
interface Required {
  readonly kind: Kind;
  readonly standIn?: () => unknown;
}

const req = (kind: Kind, standIn?: unknown): Required => (standIn === undefined ? { kind } : { kind, standIn: () => standIn });

const LAT_LON = { latitude: req('number', 0), longitude: req('number', 0) };

/**
 * Fields a report always has, other than the text the absent-text rule covers. A field with a
 * stand-in is replaced by it when missing or of the wrong kind, and its refusal waits for the
 * rest of the record to be checked, so a fault earlier in the Refusal reasons order wins. Two
 * have none, because nothing is left to check without them: an NMEA sentence (the sentence is the
 * data) and a third-party packet (the packet is everything after the `}`).
 */
const REQUIRED: Readonly<Record<string, Readonly<Record<string, Required>>>> = {
  position: LAT_LON,
  object: LAT_LON,
  item: LAT_LON,
  'mic-e': { ...LAT_LON, micEMessage: req('string', 'off-duty') },
  message: { text: req('string', '') },
  ack: { ackedId: req('string', '1') },
  reject: { rejectedId: req('string', '1') },
  bulletin: { text: req('string', '') },
  'nws-bulletin': { text: req('string', '') },
  'telemetry-names': { names: req('array', ['A']) },
  'telemetry-units': { units: req('array', ['V']) },
  'telemetry-coefficients': { coefficients: req('array', [0, 1, 0]) },
  'telemetry-bits': { bits: req('string', '00000000') },
  'directed-query': {},
  status: {},
  telemetry: { sequence: req('string', '000'), analog: req('array', [0, 0, 0, 0, 0]) },
  weather: { weather: req('object', {}) },
  'raw-weather': { format: req('string', 'peet-bros-hash') },
  nmea: { sentence: req('string') },
  'maidenhead-beacon': { locator: req('string', 'AA00') },
  query: {},
  capabilities: { capabilities: req('array', []) },
  'third-party': { packet: req('object') },
  'user-defined': { userId: req('string', 'X'), packetType: req('string', 'X') },
  test: {},
  'agrelo-df': { bearingDegrees: req('number', 0), quality: req('number', 0) },
  unrecognized: {},
};

/** An inner packet's fields, with stand-ins that read as a well-formed header and an empty field. */
const PACKET: Readonly<Record<string, Required>> = {
  source: req('string', 'A'),
  destination: req('string', 'B'),
  path: req('array', []),
  information: { kind: 'bytes', standIn: () => new Uint8Array(0) },
  data: req('object', { type: 'unrecognized', reason: 'empty' }),
  diagnostics: req('array', []),
};

const pending = new WeakMap<object, AprsEncodeError[]>();

/** The shape refusals held for data until the rest of it has been checked. */
export function pendingShapeFaults(data: object): readonly AprsEncodeError[] {
  return pending.get(data) ?? [];
}

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

/** Checks the required fields; gives a copy with stand-ins, and the refusals held for them. */
function checkFields(o: Record<string, unknown>, fields: Readonly<Record<string, Required>>, what: string, held: AprsEncodeError[]): Record<string, unknown> {
  let out = o;
  for (const [k, r] of Object.entries(fields)) {
    const missing = o[k] === undefined;
    if (!missing && isKind(o[k], r.kind)) continue;
    const code: RefusalCode = missing ? 'missing-field' : 'malformed';
    const reason = missing ? `${what} needs ${k}` : `${what}: ${k} is not a ${r.kind}`;
    if (r.standIn === undefined) refuse(code, reason);
    held.push(new AprsEncodeError(reason, code));
    if (out === o) out = { ...o };
    out[k] = r.standIn();
  }
  return out;
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
  const held: AprsEncodeError[] = [];
  const out = checkFields(d, REQUIRED[type]!, type, held);
  const copy = (): Record<string, unknown> => (out === d ? { ...d } : out);
  let result = out;
  const fill = (k: string, v: unknown): void => {
    if (result === d) result = copy();
    result[k] = v;
  };
  for (const k of TEXT[type] ?? []) if (typeof d[k] !== 'string') fill(k, '');
  if (POSITIONED.has(type)) {
    const s = d.symbol;
    if (!isData(s) || typeof s.table !== 'string' || typeof s.code !== 'string') fill('symbol', { table: '', code: '' });
  }
  if (type === 'third-party') {
    const p = checkFields(d.packet as Record<string, unknown>, PACKET, 'a third-party packet', held);
    fill('packet', { ...p, data: normalise(p.data as Record<string, unknown>) });
  }
  if (held.length > 0) {
    if (result === d) result = copy();
    pending.set(result, held);
  }
  return result as unknown as AprsData;
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
