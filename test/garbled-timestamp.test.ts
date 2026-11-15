// Round 5: a garbled timestamp ending in z, / or h before an UNCOMPRESSED position is skipped,
// even when the garbled bytes would read as a compressed position straight after the DTI.

import { describe, expect, it } from 'vitest';
import { decodeTnc2, encodeInformation, hasErrors, ParseOptions } from '../src/index.js';
import { decodeUtf8 } from '../src/bytes.js';

const hdr = 'N0CALL>APZ001:';
const codes = (line: string, o?: ParseOptions): string[] => decodeTnc2(line, o).diagnostics.map((d) => `${d.severity}:${d.code}`);
const lat = (line: string, o?: ParseOptions): number | undefined => {
  return (decodeTnc2(line, o).data as { latitude?: number }).latitude;
};

describe('a garbled timestamp before an uncompressed position', () => {
  it.each([
    ['@', 'z'],
    ['@', '/'],
    ['@', 'h'],
    ['/', 'z'],
    ['/', '/'],
    ['/', 'h'],
  ])('DTI %s, seventh byte %s: read after the seven bytes', (dti, c) => {
    const line = `${hdr}${dti}R30549${c}2831.07N/08142.92W_015/001g006t058`;
    expect(lat(line)).toBeCloseTo(28.5178333, 6);
    expect(codes(line)).toEqual(['warning:malformed-timestamp']);
  });

  it('is rejected by malformed-timestamp when strict', () => {
    const line = `${hdr}@R30549z2831.07N/08142.92W_015/001g006t058`;
    const p = decodeTnc2(line, ParseOptions.strict);
    expect(hasErrors(p)).toBe(true);
    expect(p.diagnostics[0]!.code).toBe('malformed-timestamp');
  });

  it('re-encodes without a timestamp', () => {
    const at = decodeTnc2(`${hdr}@R30549z2831.07N/08142.92W-`);
    expect(decodeUtf8(encodeInformation(at.data).information)).toBe('=2831.07N/08142.92W-');
    const sl = decodeTnc2(`${hdr}/R30549z2831.07N/08142.92W-`);
    expect(decodeUtf8(encodeInformation(sl.data).information)).toBe('!2831.07N/08142.92W-');
  });

  it('a lower-case hemisphere after the seven bytes is read leniently', () => {
    const line = `${hdr}@R30549z2831.07n/08142.92w-`;
    expect(lat(line)).toBeCloseTo(28.5178333, 6);
    expect(codes(line)).toEqual(expect.arrayContaining(['warning:malformed-timestamp', 'warning:lowercase-hemisphere']));
  });

  it('a lower-case hemisphere is rejected strictly (still by the timestamp first)', () => {
    const p = decodeTnc2(`${hdr}@R30549z2831.07n/08142.92w-`, ParseOptions.strict);
    expect(hasErrors(p)).toBe(true);
    expect(p.diagnostics[0]!.code).toBe('malformed-timestamp');
  });

  it('position ambiguity after the seven bytes is read', () => {
    const line = `${hdr}@R30549z283 .  N/0814 .  W-`;
    expect(lat(line)).toBeCloseTo(28.5833333, 5);
    expect(codes(line)).toContain('warning:malformed-timestamp');
    expect(hasErrors(decodeTnc2(line, ParseOptions.strict))).toBe(true);
  });

  it('a seventh byte that is not a time indicator keeps the old reading', () => {
    const line = `${hdr}@R30549x2831.07N/08142.92W-`;
    expect(lat(line)).not.toBeCloseTo(28.5178333, 3);
  });

  it('a compressed position after the seven bytes does not win', () => {
    const line = `${hdr}@R30549z/5L!!<*e7>{?!`;
    const a = decodeTnc2(line);
    const b = decodeTnc2(`${hdr}@R30549z/5L!!<*e7>{?!`);
    expect(a.diagnostics.map((d) => d.code)).toEqual(b.diagnostics.map((d) => d.code));
  });

  it('a field shorter than nine bytes cannot take the branch', () => {
    expect(() => decodeTnc2(`${hdr}@R30549z`)).not.toThrow();
    expect(() => decodeTnc2(`${hdr}@R30549z2`)).not.toThrow();
  });

  it('a valid timestamp is unchanged', () => {
    const line = `${hdr}@092345z2831.07N/08142.92W-`;
    expect(codes(line)).toEqual([]);
  });
});
