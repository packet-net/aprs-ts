// The public decoding functions.

import { encodeUtf8 } from './bytes.js';
import { decodeInformation } from './decode/index.js';
import { identifyMicE, identifyTocall } from './deviceid.js';
import { ParseOptions } from './diagnostics.js';
import { findQConstruct, parseAx25Frame, parseTnc2Header, type ParsedHeader } from './header.js';
import type { AprsPacket } from './types.js';

function assemble(header: ParsedHeader, options: ParseOptions): AprsPacket {
  const decoded = decodeInformation(header.info, header.destination, options);
  const packet: { -readonly [K in keyof AprsPacket]: AprsPacket[K] } = {
    source: header.source,
    destination: header.destination,
    path: header.path,
    information: header.info,
    data: decoded.data,
    diagnostics: [...header.diagnostics, ...decoded.diagnostics],
  };
  const q = findQConstruct(header.path);
  if (q) packet.qConstruct = q;
  const device =
    decoded.data.type === 'mic-e'
      ? identifyMicE(decoded.data.typeCode, decoded.data.deviceSuffix)
      : identifyTocall(header.destination);
  if (device) packet.device = device;
  return packet;
}

/**
 * Decodes a TNC2 / APRS-IS line (`SOURCE>DEST,PATH:information`), as text or as the bytes
 * received. A string is taken as UTF-8.
 *
 * Throws `AprsHeaderError` when the header is unusable; everything else is reported in the
 * packet's diagnostics, and data that cannot be decoded is `{ type: 'unrecognized' }`.
 */
export function decodeTnc2(line: string | Uint8Array, options: ParseOptions = ParseOptions.lenient): AprsPacket {
  const bytes = typeof line === 'string' ? encodeUtf8(line) : line;
  return assemble(parseTnc2Header(bytes, options), options);
}

/**
 * Decodes an AX.25 UI frame in KISS form: the address, control, PID and information fields,
 * with no flags and no FCS. Throws `AprsHeaderError` when it is not an APRS frame.
 */
export function decodeAx25(frame: Uint8Array, options: ParseOptions = ParseOptions.lenient): AprsPacket {
  return assemble(parseAx25Frame(frame, options), options);
}

/**
 * Decodes a KISS frame as read from a TNC: strips any FEND delimiters, undoes FESC escaping and
 * drops the port/command byte (which must be a data frame), then decodes the AX.25 frame.
 */
export function decodeKiss(frame: Uint8Array, options: ParseOptions = ParseOptions.lenient): AprsPacket {
  return decodeAx25(unwrapKiss(frame), options);
}

/** Removes KISS framing: FEND delimiters, FESC escapes and the command byte. */
export function unwrapKiss(frame: Uint8Array): Uint8Array {
  let start = 0;
  let end = frame.length;
  while (start < end && frame[start] === 0xc0) start++;
  while (end > start && frame[end - 1] === 0xc0) end--;
  const out: number[] = [];
  for (let i = start; i < end; i++) {
    const b = frame[i]!;
    if (b === 0xdb && i + 1 < end) {
      const n = frame[++i]!;
      out.push(n === 0xdc ? 0xc0 : n === 0xdd ? 0xdb : n);
    } else {
      out.push(b);
    }
  }
  if (out.length === 0 || (out[0]! & 0x0f) !== 0) throw new RangeError('not a KISS data frame');
  return Uint8Array.from(out.slice(1));
}
