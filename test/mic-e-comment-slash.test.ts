// A Mic-E comment that would read back as a device suffix is written after a space and a slash.

import { describe, expect, it } from 'vitest';
import { decodeTnc2, encodeInformation, type AprsData } from '../src/index.js';

const base = { type: 'mic-e', latitude: 8.43, longitude: 44.11, symbol: { table: '/', code: 'k' }, speedKnots: 0, typeCode: "'", micEMessage: 'off-duty' } as const;
const text = (extra: Record<string, unknown>): string => Buffer.from(encodeInformation({ ...base, ...extra } as AprsData).information).toString('latin1');
const tail = (s: string): string => s.slice(s.indexOf("'") + 1);

describe('a Mic-E comment after a frequency', () => {
  it('X at the end is written ` /X`', () => {
    expect(tail(text({ comment: 'X', frequency: { mhz: 144.39 } }))).toBe('144.390MHz /X');
  });
  it('a comment that is no suffix follows a space with no slash', () => {
    expect(tail(text({ comment: 'Hi', frequency: { mhz: 144.39 } }))).toBe('144.390MHz Hi');
  });
  it('with telemetry after it ` X` needs no slash', () => {
    expect(tail(text({ comment: 'X', frequency: { mhz: 144.39 }, telemetry: { sequence: 1, analog: [1] } }))).toMatch(/^144\.390MHz X\|/);
  });
  it('a comment that reads as more frequency fields is written straight on', () => {
    expect(tail(text({ comment: '-500 T110 V-Alert', frequency: { mhz: 445.95 } }))).toBe('445.950MHz-500 T110 V-Alert');
  });
});

describe('a Mic-E comment after a locator', () => {
  it('X at the end is written ` /X`', () => {
    expect(tail(text({ comment: 'X', locator: 'IO91' }))).toBe('IO91/G /X');
  });
  it('X before telemetry takes no slash', () => {
    expect(tail(text({ comment: 'X', locator: 'IO91', telemetry: { sequence: 1, analog: [1] } }))).toMatch(/^IO91\/G X\|/);
  });
  it('reads back as itself', () => {
    const line = 'N0CALL>' + 'P82U8L' + ':' + text({ comment: 'X', locator: 'IO91' });
    expect(decodeTnc2(line).data).toMatchObject({ comment: 'X' });
  });
});

describe('a run-on weather value before a lifted element', () => {
  const codes = (line: string) => decodeTnc2(line).diagnostics.map((d) => d.code);
  it.each([
    ['telemetry', 'N0CALL>APZ001:!4903.50N/07201.75W_220/004g005t2147483647|!!!!|hello'],
    ['a DAO', 'N0CALL>APZ001:!4903.50N/07201.75W_220/004g005t2147483647!w3U!tail'],
    ['a DAO in a compressed report', 'N0CALL>APZ001:=/5L!!<*e7_7P[g005t2147483647!w3U!tail'],
  ])('is dropped before %s, and the text after stays apart', (_n, line) => {
    expect(codes(line)).toContain('out-of-range-value');
    const w = (decodeTnc2(line).data as { weather: Record<string, unknown> }).weather;
    expect(w.windGustMph).toBe(5);
    expect(w.temperatureF).toBeUndefined();
  });
});
