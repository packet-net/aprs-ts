import type { AprsData } from '../types.js';

/** Thrown when the encoder declines to write something the spec does not allow; says why. */
export class AprsEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AprsEncodeError';
  }
}

/** Encodes data as an information field; Mic-E also gives the destination address. */
export function encodeInformation(data: AprsData): { info: Uint8Array; destination?: string } {
  throw new AprsEncodeError(`not yet: ${data.type}`);
}
