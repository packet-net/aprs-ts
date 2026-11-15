// Round 5 final pass: a later Mic-E altitude never uses the bytes of a whole `/A=`, a missing locator
// space is met before a later altitude's warning, and hostile input is decoded in linear work.

import { describe, expect, it } from 'vitest';
import { decodeTnc2, ParseOptions } from '../src/index.js';

const mice = (info: string, options?: ParseOptions) => decodeTnc2(`N0CALL>S32UVT:\`(_fn"Oj/${info}`, options);
const view = (info: string, options?: ParseOptions) => mice(info, options).data as { altitudeFeet?: number; comment?: string; type: string };

describe('a later Mic-E altitude never uses the bytes of a whole /A=', () => {
  it.each([
    ['x/A=000100}', 100, 'x}'],
    ['x/A=000100}y', 100, 'x}y'],
    ['xyz/A=-00016}', -16, 'xyz}'],
  ])('%j gives %d ft and comment %j, lenient and strict', (info, feet, comment) => {
    for (const options of [ParseOptions.lenient, ParseOptions.strict]) {
      const d = view(info, options);
      expect(d.altitudeFeet).toBe(feet);
      expect(d.comment).toBe(comment);
    }
  });

  it('a later altitude clear of the /A= is still taken, lenient only', () => {
    const d = view('x/A=000100}y"4e}z');
    expect(d.altitudeFeet).toBe(100);
    expect(d.comment).toBe('x}yz');
    const diags = mice('x/A=000100}y"4e}z').diagnostics.map((x) => x.code);
    expect(diags).toContain('mic-e-altitude-not-first');
  });

  it('a later altitude overlapping a five-digit altitude is taken (it is not whole)', () => {
    const d = view('x/A=00010}');
    expect(d.altitudeFeet).not.toBe(10);
    expect(d.comment).toBe('x/A=00');
  });

  it('a later altitude after an altitude that is not whole is taken', () => {
    expect(view('x/A=0001}').altitudeFeet).toBeGreaterThan(1000);
  });
});

describe('a missing locator space is met before a later altitude', () => {
  const noSpace = ParseOptions.lenient.without('missing-space-after-locator');
  it('rejects with no mic-e-altitude-not-first warning', () => {
    const p = mice('`(_fn"Oj/IO91/GPHG3330h{55}ello'.slice('`(_fn"Oj/'.length));
    expect(p.diagnostics.map((d) => d.code)).toContain('mic-e-altitude-not-first');
    const q = decodeTnc2('N0CALL>S32UVT:`(_fn"Oj/IO91/GPHG3330h{55}ello"Oj}x', noSpace);
    expect(q.diagnostics.map((d) => d.code)).not.toContain('mic-e-altitude-not-first');
    expect(q.diagnostics.find((d) => d.severity === 'error')?.code).toBe('missing-space-after-locator');
  });
  it('keeps the order of warnings when both are tolerated', () => {
    const codes = decodeTnc2('N0CALL>S32UVT:`(_fn"Oj/IO91/GPHG3330h{55}ello"Oj}x').diagnostics.map((d) => d.code);
    expect(codes.indexOf('mic-e-altitude-not-first')).toBeLessThan(codes.indexOf('missing-space-after-locator'));
  });
});

// Work, not time: the decoder is run at two sizes and the time of the larger one is compared with
// the smaller. A linear decoder takes about twice as long; a quadratic one about four times.
function best(line: Buffer, runs: number): number {
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    decodeTnc2(line);
    b = Math.min(b, Number(process.hrtime.bigint() - t));
  }
  return b;
}

const HEADS: Record<string, string> = {
  position: 'N0CALL>APRS:!4903.50N/07201.75W-',
  signpost: 'N0CALL>APRS:!4903.50N/07201.75W\\',
  weather: 'N0CALL>APRS:!4903.50N/07201.75W_',
  'mic-e': 'N0CALL>S32UVT:`(_fn"Oj/',
  'mic-e after a locator': 'N0CALL>S32UVT:`(_fn"Oj/>IO91/G ',
};
const ELEMENTS = ['{', 'PHG1', '|!!|', '/A=000001', '!W12!', '"4e}', '}', '/A=000100}'];
const SMALL = 40_000;
const LARGE = 160_000;

describe('hostile input is decoded in linear time', () => {
  for (const [name, head] of Object.entries(HEADS)) {
    for (const el of ELEMENTS) {
      it(`${name}: ${JSON.stringify(el)} repeated`, () => {
        const line = (n: number) => Buffer.from(head + el.repeat(Math.ceil(n / el.length)).slice(0, n), 'latin1');
        const small = line(SMALL);
        const large = line(LARGE);
        decodeTnc2(small); // warm up
        const a = best(small, 3);
        const b = best(large, 3);
        // 4x the size: linear is about 4x the time, quadratic about 16x. Allow generous noise.
        expect(b / Math.max(a, 1e5)).toBeLessThan(10);
      });
    }
  }
});
