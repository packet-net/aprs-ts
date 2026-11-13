// The information field decoder: picks the format by the data type identifier.

import { binaryToBytes, bytesToBinary } from '../bytes.js';
import { ParseOptions, type Diagnostic } from '../diagnostics.js';
import { identifyDevice } from '../deviceid.js';
import { parseHeaderText } from '../header.js';
import type { AprsData, AprsPacket, ThirdParty } from '../types.js';
import { DecodeContext, Rejected } from './context.js';
import { decodeMessage } from './message.js';
import {
  decodeAgrelo,
  decodeCapabilities,
  decodeDollar,
  decodeMaidenhead,
  decodeQuery,
  decodeRawWeather,
  decodeStatus,
  decodeTelemetry,
  decodeTest,
  decodeUserDefined,
} from './other.js';
import { positionDecodesAt } from './positioned.js';
import { decodeItem, decodeMicE, decodeObject, decodePositionlessWeather, decodePositionReport } from './reports.js';

/** The result of decoding an information field. */
export interface DecodedInformation {
  readonly data: AprsData;
  readonly diagnostics: readonly Diagnostic[];
}

/** Decodes an information field; `destination` matters for Mic-E. `options` default to lenient. */
export function decodeInformation(information: Uint8Array, destination: string, options: ParseOptions = ParseOptions.lenient): DecodedInformation {
  return decodeInformationAt(information, destination, options, 0);
}

/** How many third-party headers a decoder reads, one inside another (vectors interpretations.md). */
const MAX_THIRD_PARTY_DEPTH = 4;

/** Decodes an information field enclosed in `depth` third-party headers. */
function decodeInformationAt(information: Uint8Array, destination: string, options: ParseOptions, depth: number): DecodedInformation {
  const info = information;
  const ctx = new DecodeContext(options, destination);
  let data: AprsData;
  try {
    let end = info.length;
    while (end > 0 && (info[end - 1] === 0x0d || info[end - 1] === 0x0a)) end--;
    if (end < info.length) ctx.tolerate('trailing-line-break');
    data = dispatch(ctx, bytesToBinary(info, 0, end), options, depth);
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    data = { type: 'unrecognized', reason: 'malformed' };
  }
  return { data, diagnostics: ctx.diagnostics };
}

function dispatch(ctx: DecodeContext, s: string, options: ParseOptions, depth: number): AprsData {
  if (s.length === 0) return { type: 'unrecognized', reason: 'empty' };
  switch (s[0]) {
    case '!':
      if (s[1] === '!') return decodeRawWeather(ctx, s.slice(2), 'ultimeter-logging');
      return decodePositionReport(ctx, s);
    case '=':
    case '/':
    case '@':
      return decodePositionReport(ctx, s);
    case '`':
    case "'":
    case '\x1c':
    case '\x1d':
      return decodeMicE(ctx, s);
    case ';':
      return decodeObject(ctx, s);
    case ')':
      return decodeItem(ctx, s);
    case ':':
      return decodeMessage(ctx, s);
    case '>':
      return decodeStatus(ctx, s);
    case '<':
      return decodeCapabilities(ctx, s);
    case '?':
      return decodeQuery(ctx, s);
    case 'T':
      return decodeTelemetry(ctx, s);
    case '_':
      return decodePositionlessWeather(ctx, s);
    case '#':
      return decodeRawWeather(ctx, s.slice(1), 'peet-bros-hash');
    case '*':
      return decodeRawWeather(ctx, s.slice(1), 'peet-bros-star');
    case '$':
      return decodeDollar(ctx, s);
    case '%':
      return decodeAgrelo(ctx, s);
    case '{':
      return decodeUserDefined(ctx, s);
    case '}':
      return decodeThirdParty(ctx, s, options, depth);
    case ',':
      return decodeTest(ctx, s);
    case '[':
      return decodeMaidenhead(ctx, s);
    case '&':
    case '+':
    case '.':
      ctx.info('reserved-data-type');
      return { type: 'unrecognized', reason: 'reserved-data-type' };
    default: {
      // The obsolete TNC beacon rule: a ! position anywhere in the first 40 characters.
      const bang = s.indexOf('!');
      if (bang > 0 && bang < 40 && positionDecodesAt(ctx, s, bang + 1) && ctx.allows('position-not-at-start')) {
        return decodePositionReport(ctx, s.slice(bang));
      }
      ctx.info('not-aprs');
      return { type: 'unrecognized', reason: 'not-aprs' };
    }
  }
}

function decodeThirdParty(ctx: DecodeContext, s: string, options: ParseOptions, depth: number): ThirdParty {
  // Third-party packets nest at most four deep: a fifth `}` is not read.
  if (depth >= MAX_THIRD_PARTY_DEPTH) ctx.fail('invalid-third-party');
  const body = s.slice(1);
  const colon = body.indexOf(':');
  if (colon < 0) ctx.fail('invalid-third-party');
  const headerDiags: Diagnostic[] = [];
  let header: ReturnType<typeof parseHeaderText>;
  try {
    header = parseHeaderText(body.slice(0, colon), options, headerDiags, true);
  } catch {
    return ctx.fail('invalid-third-party');
  }
  const info = binaryToBytes(body.slice(colon + 1));
  const inner = decodeInformationAt(info, header.destination, options, depth + 1);
  const packet: { -readonly [K in keyof AprsPacket]: AprsPacket[K] } = {
    source: header.source,
    destination: header.destination,
    path: header.path,
    information: info,
    data: inner.data,
    diagnostics: [...headerDiags, ...inner.diagnostics],
  };
  // The inner packet has its device too, from its own destination (vectors rulings, A2).
  const device = identifyDevice(inner.data, header.destination);
  if (device) packet.device = device;
  // A q-construct is read only in the outer header: the third-party path is kept as sent.
  return { type: 'third-party', packet };
}

