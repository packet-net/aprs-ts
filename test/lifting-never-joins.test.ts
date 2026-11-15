// Round 5: lifting an element never joins the text either side of it. Variations beyond the shared
// cases: other pairs of elements, both orders, in each kind of comment.

import { describe, expect, it } from 'vitest';
import { AprsEncodeError, decodeTnc2, encodeInformation } from '../src/index.js';

type Data = {
  comment?: string;
  phg?: unknown;
  rangeMiles?: number;
  altitudeFeet?: number;
  telemetry?: unknown;
  dao?: unknown;
  frequency?: Record<string, unknown>;
};
const POS = 'N0CALL>APRS:!4903.50N/07201.75W>';
const MICE = 'N0CALL>S32UVT:`(_fn"Oj/>';
const read = (line: string) => {
  const p = decodeTnc2(line);
  return { data: p.data as unknown as Data, codes: p.diagnostics.map((d) => d.code), data0: p.data };
};
const refusal = (line: string): string | undefined => {
  try {
    encodeInformation(decodeTnc2(line).data);
  } catch (e) {
    if (e instanceof AprsEncodeError) return e.code;
    throw e;
  }
  return undefined;
};

describe('an element split by another is text, and re-encoding refuses text that reads as one', () => {
  it.each([
    // [line, comment left]
    ['N0CALL>APRS:;OBJECT   *111111z4903.50N/07201.75W>PH|!!!!|G3330 x', 'PHG3330 x'],
    [`${POS} x/A=00!W12!0123`, 'x/A=000123'],
    [`${POS}RNG0/A=000100001`, 'RNG0001'],
    [`${MICE}RNG0!W12!001`, 'RNG0001'],
    [`${MICE} x/A=00|!!!!|0123`, 'x/A=000123'],
  ])('%j', (line, comment) => {
    const { data } = read(line);
    expect(data.comment).toBe(comment);
    expect(data.phg).toBeUndefined();
    expect(data.rangeMiles).toBeUndefined();
    expect(refusal(line)).toBe('text-reads-as-field');
  });

  it('keeps the altitude that splits a range, and reads no range', () => {
    const { data } = read(`${POS}RNG0/A=000100001`);
    expect(data.altitudeFeet).toBe(100);
  });
});

describe('a voice frequency read across lifted elements', () => {
  it('a !DAO! between the frequency and a field cuts the field off', () => {
    const { data } = read(`${POS}146.520MHz T100!W12! +060`);
    expect(data.frequency).toEqual({ mhz: 146.52, tone: 'tone', toneValue: 100 });
    expect(data.comment).toBe('+060');
  });

  it('telemetry between the frequency and a field cuts it off, in an item', () => {
    const { data } = read('N0CALL>APRS:)ITEM!4903.50N/07201.75W>146.520MHz T100|!!!!|+060');
    expect(data.frequency).toEqual({ mhz: 146.52, tone: 'tone', toneValue: 100 });
    expect(data.comment).toBe('+060');
  });

  it('an altitude after a field does not cut off the next, in either order of fields', () => {
    const { data } = read(`${POS}146.520MHz T100 +060/A=000100 R05m`);
    expect(data.frequency).toEqual({ mhz: 146.52, tone: 'tone', toneValue: 100, offsetKhz: 600, range: 5 });
    expect(data.altitudeFeet).toBe(100);
    expect(data.comment).toBeUndefined();
  });

  it('a space before the altitude is not the next field leading space', () => {
    const { data } = read(`${POS}146.520MHz T100 /A=000100 +060`);
    expect(data.frequency).toEqual({ mhz: 146.52, tone: 'tone', toneValue: 100 });
    expect(data.comment).toBe('+060');
  });

  it('a !DAO! after the frequency leaves the field text, in Mic-E status text', () => {
    const { data } = read(`${MICE}146.520MHz !W12!T100`);
    expect(data.frequency).toEqual({ mhz: 146.52 });
    expect(data.comment).toBe('T100');
  });

  it('a Mic-E altitude between the frequency and a field cuts it off', () => {
    const { data, codes } = read(`${MICE}146.520MHz T100"4e}+060`);
    expect(data.frequency).toEqual({ mhz: 146.52, tone: 'tone', toneValue: 100 });
    expect(data.comment).toBe('+060');
    expect(codes).toContain('mic-e-altitude-not-first');
  });
});

describe('a weather report', () => {
  it('reads a software type and unit standing whole before a !DAO!', () => {
    const line = 'N0CALL>APRS:!4903.50N/07201.75W_220/004g005t077r000!W12!Xyz';
    expect(read(line).data0).toMatchObject({ weather: { software: 'X', unit: 'yz' } });
  });

  it('keeps a software type and unit split by a !DAO! as text', () => {
    const line = 'N0CALL>APRS:!4903.50N/07201.75W_220/004g005t077r000Xy!W12!z';
    const { data } = read(line);
    expect(data.comment).toBe('Xyz');
    expect((data0(line).weather as { software?: string }).software).toBeUndefined();
  });
});

function data0(line: string): { weather: Record<string, unknown> } {
  return decodeTnc2(line).data as unknown as { weather: Record<string, unknown> };
}
