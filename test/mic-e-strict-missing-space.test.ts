// Round 5: a strict decoder meets a locator missing its space before an altitude left across a
// lifted place, and a leading altitude plus a locator reads a PHG or RNG only as sent.

import { describe, expect, it } from 'vitest';
import { decodeTnc2, ParseOptions } from '../src/index.js';

const tnc = (info: string) => `N0CALL>S32UVT:\`(_fn"Oj/${info}`;
const strictCode = (info: string): string | undefined => {
  return decodeTnc2(tnc(info), ParseOptions.strict).diagnostics.find((d) => d.severity === 'error')?.code;
};

describe('strict: the missing space is met before an altitude left across a lifted place', () => {
  it.each([
    ']IO91/G!w3U!}PHG5132=',
    '>IO91SX/G!W12!}"4T}',
    '`IO91/G!W12!"e} x',
    '`io91sx/G"4e}!W12!!W12!}=',
    '>IO91/G"4"4T}T}!W1|!:&0\'p|}',
    '>IO91SX/G"4e}hello|!:&0hl!Y[=\'p|}',
    '`IO91/Gx!W12!ab}',
  ])('%j is rejected by missing-space-after-locator', (info) => {
    expect(strictCode(info)).toBe('missing-space-after-locator');
  });

  it('reads a later altitude as text when the locator has its space', () => {
    expect(strictCode('`IO91/G x!W12!ab}')).toBeUndefined();
  });
});

describe('a PHG after a leading altitude and a locator', () => {
  const phg = (info: string) => (decodeTnc2(tnc(info), ParseOptions.strict.with('data-extension-in-comment')).data as { phg?: unknown }).phg;
  const codes = (info: string) => decodeTnc2(tnc(info)).diagnostics.map((d) => d.code);

  it('as sent is read', () => {
    expect(phg('>"4T}IO91/G PHG3330')).toBeDefined();
  });
  it.each(['>"4T}IO91/G!W12!PHG3330', '>"4T}IO91/G|!:&0\'p|PHG3330'])('%j is late', (info) => {
    expect(phg(info)).toBeUndefined();
    expect(codes(info)).toContain('data-extension-in-comment');
  });
});

describe('a PHG split by a lifted element is text', () => {
  it.each(['>PH!W12!G3330', ' PH!w3U!G3330'])('%j', (info) => {
    const p = decodeTnc2(tnc(info));
    expect(p.diagnostics.map((d) => d.code)).not.toContain('data-extension-in-comment');
    expect((p.data as { phg?: unknown; comment?: string }).phg).toBeUndefined();
    expect((p.data as { comment?: string }).comment).toBe('PHG3330');
    expect((decodeTnc2(tnc(info), ParseOptions.strict).data as { phg?: unknown }).phg).toBeUndefined();
  });
});
