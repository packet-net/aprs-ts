// A PHG or RNG straight after a Mic-E locator with no space: the missing space is reported whatever follows.

import { describe, expect, it } from 'vitest';
import { decodeTnc2 } from '../src/index.js';

const head = "N0CALL>SUSPU4:'C=?] \u001c#S]IO91/G";
const codes = (tail: string): string[] => decodeTnc2(head + tail).diagnostics.map((d) => d.code);

describe('a locator missing its space before a PHG or RNG', () => {
  it.each([
    ['PHG3330 24PH}#SlW1='],
    ['RNG0050 24PH}#SlW1='],
    ['PHG3330 hello'],
    ['PHG3330 2#SlW1='],
  ])('%s warns once', (tail) => {
    expect(codes(tail).filter((c) => c === 'missing-space-after-locator')).toHaveLength(1);
  });

  it('with a later altitude gives both warnings', () => {
    expect(codes('PHG3330 24PH}#SlW1=')).toEqual(expect.arrayContaining(['missing-space-after-locator', 'mic-e-altitude-not-first']));
  });

  it('a space after the locator is no warning', () => {
    expect(codes(' PHG3330 24PH}#SlW1=')).not.toContain('missing-space-after-locator');
  });
});
