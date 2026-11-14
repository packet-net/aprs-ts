// What a program does with a packet it received: ask about its diagnostics, write it out again as
// received, and read the values behind a PHG's codes.

import { encodeUtf8 } from './bytes.js';
import { ax25Of, tnc2TextOf } from './encode/index.js';
import { guarded } from './encode/shape.js';
import { formatTnc2Header } from './header.js';
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
 * field exactly as received. Nothing is checked or re-encoded: this writes out a packet the program
 * already holds, it is not an encoder, so it makes no size check (a received field over 256 bytes
 * is written as it came).
 */
export function packetToTnc2Bytes(packet: AprsPacket): Uint8Array {
  return guarded(() => {
    const header = encodeUtf8(`${formatTnc2Header(packet.source, packet.destination, packet.path)}:`);
    const out = new Uint8Array(header.length + packet.information.length);
    out.set(header, 0);
    out.set(packet.information, header.length);
    return out;
  });
}

/**
 * A received packet as a TNC2 / APRS-IS line of text.
 *
 * @throws AprsEncodeError when the information field is not UTF-8 text; use `packetToTnc2Bytes`.
 */
export function packetToTnc2(packet: AprsPacket): string {
  return tnc2TextOf(packetToTnc2Bytes(packet));
}

/**
 * A received packet as an AX.25 UI frame (no flags, no FCS), the information field as received.
 * Not an encoder: the field is passed through as it stands, with no size check.
 *
 * @throws AprsEncodeError when AX.25 cannot carry an address as sent (a call over six characters,
 * an SSID written with a leading zero, an SSID over 15) or the path has more than 8 entries.
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
