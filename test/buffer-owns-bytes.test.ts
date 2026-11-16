// A decoded packet owns its bytes even when the input is a Node Buffer (Buffer#slice is a view).

import { describe, expect, it } from 'vitest';
import { Aprs, decodeAx25, decodeInformation, decodeKiss, decodeTnc2, unwrapKiss } from '../src/index.js';

const LINE = 'N0CALL>APRS:}N0CALL>APRS,TCPIP,N0CALL*:!4903.50N/07201.75W-146.520MHz/A=000100 T100!W12!x';
const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const built = Aprs.from('M0LTE-9').status('hello').build();

/** Runs `decode` on `make()` as a Buffer and as a subarray of a larger Buffer, and mutates it after. */
function check(make: () => Buffer, decode: (b: Uint8Array) => { information: Uint8Array }): void {
  const asBuffer = make();
  const p1 = decode(asBuffer);
  const seen1 = text(p1.information);
  asBuffer.fill(0x41);
  expect(text(p1.information)).toBe(seen1);
  expect(p1.information.buffer === asBuffer.buffer && p1.information.byteOffset === asBuffer.byteOffset).toBe(false);

  const made = make();
  const big = Buffer.concat([Buffer.alloc(5, 0x42), made, Buffer.alloc(5, 0x43)]);
  const sub = big.subarray(5, 5 + made.length);
  const p2 = decode(sub);
  const seen2 = text(p2.information);
  big.fill(0x41);
  expect(text(p2.information)).toBe(seen2);
  expect(p2.information.buffer).not.toBe(big.buffer);
}

describe('a decoded packet does not share memory with a Node Buffer', () => {
  it('decodeTnc2', () => {
    check(() => Buffer.from(LINE, 'latin1'), (b) => decodeTnc2(b));
  });

  it('decodeTnc2 keeps the third-party packet apart too', () => {
    const buf = Buffer.from(LINE, 'latin1');
    const p = decodeTnc2(buf);
    const inner = p.data.type === 'third-party' ? p.data.packet : undefined;
    expect(inner).toBeDefined();
    const before = text(inner!.information);
    buf.fill(0x41);
    expect(text(inner!.information)).toBe(before);
    expect(inner!.data).toMatchObject({ type: 'position' });
  });

  it('decodeAx25', () => {
    check(() => Buffer.from(built.toAx25()), (b) => decodeAx25(b));
  });

  it('decodeKiss', () => {
    check(() => Buffer.from(built.toKiss()), (b) => decodeKiss(b));
  });

  it('unwrapKiss', () => {
    const buf = Buffer.from(built.toKiss());
    const out = unwrapKiss(buf);
    const before = Array.from(out);
    buf.fill(0x41);
    expect(Array.from(out)).toEqual(before);
  });

  it('decodeInformation', () => {
    const buf = Buffer.from('!4903.50N/07201.75W-hello', 'latin1');
    const d = decodeInformation(buf, 'APRS');
    const before = JSON.stringify(d.data);
    buf.fill(0x41);
    expect(JSON.stringify(d.data)).toBe(before);
  });
});
