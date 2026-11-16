// Round 5: a Mic-E locator is read only where it stands as sent, and a PHG or RNG after it that is
// there only once something between them is lifted is late.

import { describe, expect, it } from 'vitest';
import { decodeTnc2 } from '../src/index.js';

const read = (info: string) => decodeTnc2(`N0CALL>S32UVT:\`(_fn"Oj/${info}`);
const data = (info: string) => read(info).data as { locator?: string; comment?: string; phg?: unknown; rng?: unknown };
const codes = (info: string): string[] => read(info).diagnostics.map((d) => d.code);

describe('a locator that reaches the start only once something is lifted is text', () => {
  it.each([
    '!W12!Io91/G!W1',
    '!w3U!|!:&0\'p|IO91SX/G!w3',
    '!W12!IO91SX/G hello',
    '|!:&0\'p|IO91/G x',
  ])('%j has no locator', (info) => {
    expect(data(info).locator).toBeUndefined();
  });

  it.each(['IO91/G!W12!x', 'IO91SX/G hello'])('%j still has its locator', (info) => {
    expect(data(info).locator).toBeDefined();
  });
});

describe('a PHG split by an altitude after a locator is text', () => {
  it('reads no PHG and no late one', () => {
    const info = '\'IO91/G PH"4e}G3330  ';
    expect(data(info).phg).toBeUndefined();
    expect(codes(info)).not.toContain('data-extension-in-comment');
    expect(data(info).comment).toBe('PHG3330  ');
  });
});

describe('a PHG or RNG after a locator only once something is lifted is late', () => {
  it.each([
    "'IO91/G!W12!PHG3330RNG0001",
    "'IO91/G|!:&0'p|RNG0001",
    '\'IO91/G !W12!PHG3330',
  ])('%j is read with data-extension-in-comment', (info) => {
    expect(codes(info)).toContain('data-extension-in-comment');
  });

  it.each(["'IO91/G PHG3330", "'IO91/G RNG0001"])('%j straight after the locator is not late', (info) => {
    expect(codes(info)).not.toContain('data-extension-in-comment');
  });
});
