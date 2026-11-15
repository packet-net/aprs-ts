// What a program does with a packet it received: ask about its diagnostics, write it out again as
// received, and read the values behind a PHG's codes.

import { ax25Of, tnc2BytesOf, tnc2TextOf } from './encode/index.js';
import { guarded } from './encode/shape.js';
import type { AprsPacket, Phg } from './types.js';

/** Whether decoding the packet found an error. */
export function hasErrors(packet: AprsPacket): boolean {
  return packet.diagnostics.some((d) => d.severity === 'error');
}

/** Whether decoding the packet found a warning. */
export function hasWarnings(packet: AprsPacket): boolean {
  return packet.diagnostics.some((d) => d.severity === 'warning');
}

/**
 * A received packet as the bytes of a TNC2 / APRS-IS line: its header, then the information
 * field exactly as received. The information field is not re-encoded or checked (this writes out a
 * packet the program already holds, it is not an encoder, so it makes no size check: a received
 * field over 256 bytes is written as it came), but the header written is read back like any
 * other.
 *
 * @throws AprsEncodeError: `invalid-address` or `invalid-path` for a header no form can carry (a
 * packet read from inside a third-party packet is held to the outer address rule, so an inner
 * source such as `a b` is refused), and `tnc2-cannot-carry` when the header reads back as another
 * one or the information field holds a CR or LF before its end (a line ends there).
 */
export function packetToTnc2Bytes(packet: AprsPacket): Uint8Array {
  return guarded(() => tnc2BytesOf(packet.source, packet.destination, packet.path, packet.information));
}

/**
 * A received packet as a TNC2 / APRS-IS line of text.
 *
 * @throws AprsEncodeError as `packetToTnc2Bytes` does, and `tnc2-cannot-carry` when the information
 * field is not UTF-8 text; use `packetToTnc2Bytes` for that.
 */
export function packetToTnc2(packet: AprsPacket): string {
  return tnc2TextOf(packetToTnc2Bytes(packet));
}

/**
 * A received packet as an AX.25 UI frame (no flags, no FCS), the information field as received.
 * Not an encoder: the field is passed through as it stands, with no size check.
 *
 * @throws AprsEncodeError: `invalid-address` or `invalid-path` as `packetToTnc2Bytes` does, and
 * `ax25-cannot-carry` when AX.25 cannot carry an address as sent (a call over six characters, in
 * lower case or empty, an empty destination included; an SSID written with a leading zero or over 15)
 * or the path has more than 8 entries. A CR or LF in the information field is carried.
 */
export function packetToAx25(packet: AprsPacket): Uint8Array {
  return guarded(() => ax25Of(packet.source, packet.destination, packet.path, packet.information));
}

/** What a PHG's codes stand for. */
export interface PhgValues {
  readonly powerWatts: number;
  readonly heightFeet: number;
  readonly gainDb: number;
  /** Degrees of the beam's centre; `null` for omnidirectional. */
  readonly directivityDegrees: number | null;
}

/** The power, height, gain and directivity a PHG's codes stand for (APRS12c ch. 7). */
export function phgValues(phg: Phg): PhgValues {
  return {
    powerWatts: phg.power * phg.power,
    heightFeet: 10 * 2 ** phg.height,
    gainDb: phg.gain,
    directivityDegrees: phg.directivity === 0 ? null : phg.directivity * 45,
  };
}
