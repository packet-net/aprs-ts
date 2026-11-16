// Round 5: the space after a Mic-E locator is judged on the decoder's own result, and when the
// locator has its space it is the separator, not part of the comment.

import { describe, expect, it } from 'vitest';
import { decodeTnc2, ParseOptions } from '../src/index.js';

const hdr = 'N0CALL>S32UVT:`(_fn"Oj/`';
const read = (info: string, o?: ParseOptions) => decodeTnc2(`${hdr}${info}`, o);
const comment = (info: string): string | undefined => (read(info).data as { comment?: string }).comment;
const codes = (info: string): string[] => read(info).diagnostics.map((d) => `${d.severity}:${d.code}`);

describe('Mic-E locator space', () => {
  it.each([
    ['IO91/G"4e}  x', 'x'],
    ['IO91/G"4e}   x', ' x'],
    ['IO91/G"4e} /x', 'x'],
    ['IO91/G"4e} x', 'x'],
  ])('a later altitude then %j gives comment %j with no missing-space warning', (info, want) => {
    expect(comment(info)).toBe(want);
    expect(codes(info)).toEqual(['warning:mic-e-altitude-not-first']);
  });

  it.each([
    ['IO91/G|!:&0hl!Y[/>"4e}=\'p|  x', "|!:&0hl!Y[/>='p|  x"],
    ['IO91/G|!:&0hl!Y[/>"4e}=\'p|   x', "|!:&0hl!Y[/>='p|   x"],
  ])('telemetry split by an altitude is text, kept as sent: %j', (info, want) => {
    expect(comment(info)).toBe(want);
  });

  it('a !DAO! that exists only joined across a lifted altitude is text and the locator still lacks its space', () => {
    for (const info of ['IO91/G!W1"4e}2! hi', 'IO91/G!W1"4e}2!hi']) {
      expect(codes(info).sort()).toEqual(['warning:mic-e-altitude-not-first', 'warning:missing-space-after-locator']);
      expect(comment(info)).toBe(info.endsWith(' hi') ? '!W12! hi' : '!W12!hi');
    }
  });

  it('a PHG straight after the locator still needs the space', () => {
    expect(codes('IO91/GPHG3330 hello')).toContain('warning:missing-space-after-locator');
  });
});
