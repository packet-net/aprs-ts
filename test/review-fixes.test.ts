// Decoded packets own their bytes; KISS and port errors; linear number patterns.

import { describe, expect, it } from 'vitest';
import { Aprs, AprsHeaderError, decodeAx25, decodeInformation, decodeKiss, decodeTnc2, unwrapKiss, wrapKiss } from '../src/index.js';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('a decoded packet owns its bytes', () => {
  const built = Aprs.from('M0LTE-9').status('hello').build();

  it('decodeAx25', () => {
    const buf = new Uint8Array(built.toAx25());
    const p = decodeAx25(buf);
    buf.fill(0x41);
    expect(text(p.information)).toBe('>hello');
    expect(p.data).toMatchObject({ type: 'status' });
  });

  it('decodeKiss', () => {
    const buf = new Uint8Array(built.toKiss());
    const p = decodeKiss(buf);
    buf.fill(0x41);
    expect(text(p.information)).toBe('>hello');
  });

  it('unwrapKiss result is not the input', () => {
    const buf = new Uint8Array(built.toKiss());
    const out = unwrapKiss(buf);
    const before = Array.from(out);
    buf.fill(0x41);
    expect(Array.from(out)).toEqual(before);
  });

  it('decodeTnc2 from bytes', () => {
    const buf = new TextEncoder().encode('M0LTE>APZ001:>hello');
    const p = decodeTnc2(buf);
    buf.fill(0x41);
    expect(text(p.information)).toBe('>hello');
  });

  it('decodeInformation and a third-party inner packet', () => {
    const buf = new TextEncoder().encode('}M0LTE>APZ001,TCPIP*:>inner');
    const r = decodeInformation(buf, 'APZ001');
    buf.fill(0x41);
    expect(r.data.type).toBe('third-party');
    if (r.data.type === 'third-party') expect(text(r.data.packet.information)).toBe('>inner');
    const outer = new TextEncoder().encode('N0CALL>APZ001:}M0LTE>APZ001,TCPIP*:>inner');
    const p = decodeTnc2(outer);
    outer.fill(0x41);
    if (p.data.type === 'third-party') expect(text(p.data.packet.information)).toBe('>inner');
    expect(p.data.type).toBe('third-party');
  });
});

describe('decodeKiss on unusable frames', () => {
  const cases: [string, number[]][] = [
    ['an empty frame', [0xc0, 0xc0]],
    ['no bytes', []],
    ['a non-data command', [0xc0, 0x01, 0x20, 0xc0]],
    ['a command byte on another port with a command', [0xc0, 0x13, 0xc0]],
  ];
  for (const [name, bytes] of cases) {
    it(name, () => {
      for (const f of [() => decodeKiss(Uint8Array.from(bytes)), () => unwrapKiss(Uint8Array.from(bytes))]) {
        let err: unknown;
        try {
          f();
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(AprsHeaderError);
        expect((err as AprsHeaderError).diagnostics.at(-1)?.code).toBe('not-aprs-frame');
      }
    });
  }
});

describe('toKiss port', () => {
  const b = Aprs.from('M0LTE-9').status('hi').build();
  it('accepts 0 to 15', () => {
    for (let port = 0; port <= 15; port++) expect(b.toKiss(port)[1]).toBe(port << 4);
    expect(wrapKiss(new Uint8Array(1), 15)[1]).toBe(0xf0);
  });
  it('refuses anything else', () => {
    for (const port of [16, -1, 1.5, NaN, Infinity, 256]) {
      expect(() => b.toKiss(port), String(port)).toThrow(RangeError);
      expect(() => wrapKiss(new Uint8Array(1), port), String(port)).toThrow(RangeError);
    }
  });
});

describe('number patterns are linear and keep their language', () => {
  it('a 200,000-digit run completes quickly', () => {
    const d = '1'.repeat(200_000);
    const lines = [
      `N0CALL>APZ001:T#001,${d}x,2,3,4,5,00000000`,
      `N0CALL>APZ001::N0CALL   :EQNS.${d}x,1,0`,
      `N0CALL>APZ001:?APRS? ${d}x,1,0050`,
      `N0CALL>APZ001:?APRS? ${d},1,0050`,
      `N0CALL>APZ001::N0CALL   :EQNS.${d},1,0`,
    ];
    const t0 = performance.now();
    for (const l of lines) decodeTnc2(l);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  // The old and new patterns accept exactly the same strings, over every string up to length 7
  // from the alphabet that matters.
  it('accepts the same language as the old pattern', () => {
    const oldRe = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
    const newRe = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
    const alphabet = ['1', '0', '.', '-', 'x', 'e'];
    let n = 0;
    const go = (s: string, left: number): void => {
      expect(newRe.test(s), JSON.stringify(s)).toBe(oldRe.test(s));
      n++;
      if (left === 0) return;
      for (const c of alphabet) go(s + c, left - 1);
    };
    go('', 7);
    expect(n).toBeGreaterThan(50_000);
  });

  it('telemetry, coefficient and footprint decode as before', () => {
    const tel = (v: string) => decodeTnc2(`N0CALL>APZ001:T#001,${v},2,3,4,5,00000000`).data.type;
    expect(tel('12.5')).toBe('telemetry');
    expect(tel('-.5')).toBe('telemetry');
    expect(tel('7.')).toBe('telemetry');
    expect(tel('1.2.3')).toBe('unrecognized');
    expect(tel('.')).toBe('unrecognized');
    const q = (v: string) => decodeTnc2(`N0CALL>APZ001:?APRS? ${v}`).data.type;
    expect(q('51.5,-1.2,0050')).toBe('query');
    expect(q('51.,1.,0050')).toBe('query');
    expect(q('.,1,0050')).toBe('unrecognized');
  });
});
