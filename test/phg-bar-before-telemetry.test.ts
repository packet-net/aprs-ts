// Round 5: a PHG, RNG or DFS in place is lifted before telemetry is looked for, so a bar in a PHG
// height code (any character from `0` to `~`) never opens telemetry, in Mic-E status text as in a comment.

import { describe, expect, it } from 'vitest';
import { decodeTnc2 } from '../src/index.js';

type D = { phg?: { height: number }; rangeMiles?: number; dfs?: { height: number }; telemetry?: unknown; comment?: string };
const mice = (info: string): D => decodeTnc2(`N0CALL>S32UVT:\`(_fn"Oj/${info}`).data as D;
const pos = (info: string): D => decodeTnc2(`N0CALL>APRS:!4903.50N/07201.75W-${info}`).data as D;

describe('a bar in a PHG height code is not telemetry', () => {
  it('Mic-E, PHG after the leading altitude', () => {
    const d = mice('"4e}PHG1|146.520MHz!!|');
    expect(d.phg?.height).toBe(76);
    expect(d.telemetry).toBeUndefined();
    expect(d.comment).toBe('6.520MHz!!|');
  });
  it('Mic-E, variations: a second PHG and a DFS', () => {
    const a = mice('"4e}PHG2|146.520MHz!!|');
    expect(a.phg?.height).toBe(76);
    expect(a.telemetry).toBeUndefined();
    const b = mice('"4e}DFS1|146.520MHz!!|');
    expect(b.dfs?.height).toBe(76);
    expect(b.telemetry).toBeUndefined();
  });
  it('Mic-E, a RNG after the leading altitude still lets telemetry stand', () => {
    const d = mice('"4e}RNG0010|!!!!|');
    expect(d.rangeMiles).toBe(10);
    expect(d.telemetry).toBeDefined();
  });
  it('position, PHG after the symbol', () => {
    const d = pos('PHG1|146.520MHz!!|');
    expect(d.phg?.height).toBe(76);
    expect(d.telemetry).toBeUndefined();
    expect(d.comment).toBe('6.520MHz!!|');
  });
  it('position, a DFS and a second PHG', () => {
    expect(pos('DFS1|146.520MHz!!|').telemetry).toBeUndefined();
    expect(pos('PHG2|146.520MHz!!|').telemetry).toBeUndefined();
  });
});
