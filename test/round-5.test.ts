// Round 5 (vectors README, Read-back and Refusal reasons at 29298ee, and the review of this library):
// what the vectors cannot pin, each test written to fail when the clause it covers is removed.
//
//   the refusal order and invalid-path, the forbidden frame and line, a header written on its own
//   the third-party inner packet at every depth, whole-unit and code fields never rounded
//   the Mic-E altitude as given, the information field a built packet gives out
//   empties, the comparison's diagnostics, header diagnostics and inner multiset
//   the refusal messages, and the cost of a record with thousands of faults

import { describe, expect, it } from 'vitest';
import {
  Aprs,
  AprsEncodeError,
  decodeTnc2,
  encodeAx25,
  encodeInformation,
  encodeTnc2,
  encodeTnc2Bytes,
  packetToAx25,
  packetToTnc2,
  packetToTnc2Bytes,
  type AprsData,
  type AprsPacket,
} from '../src/index.js';
import { encodeUtf8 } from '../src/bytes.js';
import { diagnostic } from '../src/diagnostics.js';
import { headerDifference } from '../src/encode/index.js';
import { diagnosticProblems, readBack } from '../src/encode/readback.js';
import { fromNeutralData } from '../src/neutral.js';

const text = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

/** The refusal code of a call, `written` when it did not refuse. */
function code(f: () => unknown): string {
  try {
    f();
    return 'written';
  } catch (e) {
    if (e instanceof AprsEncodeError) return e.code;
    throw e;
  }
}

function message(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof AprsEncodeError) return e.message;
    throw e;
  }
  return 'did not refuse';
}

const symbol = { table: '/', code: '>' };
const at = { latitude: 51.5, longitude: -0.1, symbol };
const status = { type: 'status', text: 'hi' } as AprsData;

/** Data in `depth` third-party packets, as neutral data a caller may write by hand. */
function nested(data: AprsData, depth: number): AprsData {
  let out = data;
  for (let i = 0; i < depth; i++) {
    out = { type: 'third-party', packet: { source: 'N0CALL', destination: 'APRS', path: [], information: new Uint8Array(0), data: out, diagnostics: [] } } as AprsData;
  }
  return out;
}

describe('the refusal order puts the header given first, whatever form is written', () => {
  const unusedBeforeUsed = [
    { address: 'WIDE1-1', used: false },
    { address: 'N0CALL-1', used: true },
  ];
  const badData = { type: 'object', name: 'WAY TOO LONG A NAME', ...at } as AprsData;

  it('refuses a path entry not marked used before a used one as invalid-path, before a data fault', () => {
    expect(code(() => encodeTnc2({ source: 'N0CALL', path: unusedBeforeUsed, data: badData }))).toBe('invalid-path');
    expect(code(() => encodeAx25({ source: 'N0CALL', path: unusedBeforeUsed, data: badData }))).toBe('invalid-path');
    expect(code(() => Aprs.from('N0CALL').via('WIDE1-1', 'N0CALL-1*').object('WAY TOO LONG A NAME', 1, 2).build())).toBe('invalid-path');
  });
  it('puts invalid-address before invalid-path', () => {
    const path = [{ address: 'WIDE1-1', used: false }, { address: 'N0CALL-1', used: true }, { address: 'no good', used: false }];
    expect(code(() => encodeTnc2({ source: 'N0CALL', path, data: status }))).toBe('invalid-address');
  });
  it('refuses a path a pass-through writer is given, in a line and a frame', () => {
    const held: AprsPacket = { ...decodeTnc2('N0CALL>APZ001:>x'), path: unusedBeforeUsed };
    expect(code(() => packetToTnc2(held))).toBe('invalid-path');
    expect(code(() => packetToAx25(held))).toBe('invalid-path');
  });
  it('lets a path with its used entries first, or all marked, through', () => {
    expect(encodeTnc2({ source: 'N0CALL', path: ['WIDE1-1*', 'N0CALL-1*', 'WIDE2-1'], data: status })).toBe('N0CALL>APZ001,WIDE1-1,N0CALL-1*,WIDE2-1:>hi');
  });
});

describe('a call never writes a frame or a line the form forbids', () => {
  it('refuses an empty destination written to a frame, and carries it in a line', () => {
    const held = decodeTnc2('N0CALL>:>x');
    expect(packetToTnc2(held)).toBe('N0CALL>:>x');
    expect(code(() => packetToAx25(held))).toBe('ax25-cannot-carry');
  });
  it('refuses a CR or LF inside the information field written as a line, in every call that writes a line', () => {
    const held = decodeTnc2('N0CALL>APZ001:>x');
    const inside: AprsPacket = { ...held, information: encodeUtf8('>a\rb') };
    expect(code(() => packetToTnc2(inside))).toBe('tnc2-cannot-carry');
    expect(code(() => packetToTnc2Bytes(inside))).toBe('tnc2-cannot-carry');
    // A frame carries it.
    expect(packetToAx25(inside).length).toBeGreaterThan(16);
    // User-defined data may hold one: the field alone is not judged, a line is.
    const injecting: AprsData = { type: 'user-defined', userId: 'A', packetType: 'x', data: 'a\nX>Y:>evil' };
    expect(encodeInformation(injecting).information.length).toBeGreaterThan(0);
    expect(code(() => encodeTnc2({ source: 'N0CALL', data: injecting }))).toBe('tnc2-cannot-carry');
    expect(code(() => encodeTnc2Bytes({ source: 'N0CALL', data: injecting }))).toBe('tnc2-cannot-carry');
    expect(code(() => encodeAx25({ source: 'N0CALL', data: injecting }))).toBe('written');
    const built = Aprs.from('N0CALL').data(injecting).build();
    expect(code(() => built.toTnc2())).toBe('tnc2-cannot-carry');
    expect(code(() => built.toTnc2Bytes())).toBe('tnc2-cannot-carry');
    expect(code(() => built.toAx25())).toBe('written');
    expect(code(() => built.toKiss())).toBe('written');
  });
  it('carries a line break at the very end of the field, which a decoder takes off', () => {
    const held = decodeTnc2('N0CALL>APZ001:>x');
    expect(packetToTnc2({ ...held, information: encodeUtf8('>x\r\n') })).toBe('N0CALL>APZ001:>x\r\n');
  });
});

describe('a header written on its own is read back by the outer rules', () => {
  const outer = decodeTnc2('N0CALL>APRS:}a b>APRS,A*,B:>hi');
  const inner = (): AprsPacket => {
    if (outer.data.type !== 'third-party') throw new Error(outer.data.type);
    return outer.data.packet;
  };

  it('refuses an inner packet whose source no outer header holds, as a line and as a frame', () => {
    expect(inner().source).toBe('a b');
    expect(code(() => packetToTnc2(inner()))).toBe('invalid-address');
    expect(code(() => packetToAx25(inner()))).toBe('invalid-address');
  });
  it('still writes that inner header inside third-party data, where the third-party rules read it', () => {
    expect(text(encodeInformation(outer.data).information)).toBe('}a b>APRS,A*,B:>hi');
  });
  it('writes an inner packet with an empty information field as received', () => {
    const empty = decodeTnc2('N0CALL>APRS:}N0CALL>APRS:');
    if (empty.data.type !== 'third-party') throw new Error(empty.data.type);
    expect(packetToTnc2(empty.data.packet)).toBe('N0CALL>APRS:');
  });
});

describe('every rule check applies to third-party inner data, at every depth', () => {
  const faults: [string, AprsData, string][] = [
    ['an out-of-range course', { type: 'position', ...at, courseDegrees: 400 } as AprsData, 'value-out-of-range'],
    ['a latitude that is not a number', { type: 'position', ...at, latitude: Number.NaN } as AprsData, 'not-a-number'],
    ['an infinite speed', { type: 'position', ...at, speedKnots: Infinity } as AprsData, 'not-a-number'],
    ['a PHG that is not whole', { type: 'position', ...at, phg: { power: 4.4, height: 2, gain: 3, directivity: 0 } } as AprsData, 'value-out-of-range'],
    ['a control character', { type: 'status', text: 'a\u0001' } as AprsData, 'invalid-character'],
    ['a name too long', { type: 'object', name: 'TOOLONGNAME', timestamp: { kind: 'dhm-zulu', day: 1, hour: 1, minute: 1 }, ...at } as AprsData, 'invalid-name'],
  ];
  for (const [what, data, want] of faults) {
    for (const depth of [1, 2, 4]) {
      it(`refuses ${what} ${depth} deep as the top level does, never with a crash`, () => {
        expect(code(() => encodeInformation(data))).toBe(want);
        expect(code(() => encodeInformation(nested(data, depth)))).toBe(want);
      });
    }
  }
  it('refuses an inner warning the written bytes do not carry as value-has-no-form, and writes one a held packet carries as received', () => {
    const warning = diagnostic('warning', 'control-character-in-text');
    const packet = (data: object, diagnostics: unknown[]): AprsData =>
      ({ type: 'third-party', packet: { source: 'A', destination: 'B', path: [], information: new Uint8Array(0), data, diagnostics } }) as unknown as AprsData;
    // A warning given that the bytes do not read back with: no form carries it.
    const gives = packet({ type: 'status', text: 'x' }, [warning]);
    expect(code(() => encodeInformation(gives))).toBe('value-has-no-form');
    expect(code(() => encodeInformation(nested(gives, 2)))).toBe('value-has-no-form');
    expect(code(() => encodeInformation(packet({ type: 'status', text: 'x' }, [diagnostic('error', 'invalid-position')])))).toBe('value-has-no-form');
    // A held packet's own warning is read back with its bytes.
    const held = decodeTnc2('N0CALL>APRS:}A>B:>x\u0007');
    if (held.data.type !== 'third-party') throw new Error(held.data.type);
    expect(text(encodeInformation(held.data).information)).toBe('}A>B:>x\u0007');
  });
});

describe('the comparison of third-party inner diagnostics is a multiset of warnings and errors', () => {
  const given = (status: string, diagnostics: string[]): AprsData =>
    ({
      type: 'third-party',
      packet: { source: 'A', destination: 'B', path: [], information: new Uint8Array(0), data: { type: 'status', text: status }, diagnostics: diagnostics.map((d) => diagnostic(d.split(':')[0] as 'warning', d.split(':')[1] as never)) },
    }) as AprsData;
  const w = 'warning:control-character-in-text';

  it('matches the same warning, given and decoded', () => {
    expect(readBack(given('x\u0007', [w]), '}A>B:>x\u0007', undefined)).toEqual([]);
  });
  it('refuses a warning given that is not decoded, as value-has-no-form', () => {
    const problems = readBack(given('x', [w]), '}A>B:>x', undefined);
    expect(problems.map((p) => p.code)).toEqual(['value-has-no-form']);
  });
  it('refuses a warning decoded that is not given', () => {
    const problems = readBack(given('x\u0007', []), '}A>B:>x\u0007', undefined);
    expect(problems.map((p) => p.code)).toEqual(['text-reads-as-field']);
  });
  it('counts a warning given twice and decoded once as one it does not carry', () => {
    expect(readBack(given('x\u0007', [w, w]), '}A>B:>x\u0007', undefined).map((p) => p.code)).toEqual(['value-has-no-form']);
  });
  it('does not compare infos, given or decoded', () => {
    expect(readBack(given('x\u0007', [w, 'info:reserved-data-type']), '}A>B:>x\u0007', undefined)).toEqual([]);
  });
});

describe('a number in a whole-unit or code field is never rounded', () => {
  const position = (more: object): AprsData => ({ type: 'position', ...at, ...more }) as AprsData;
  const fractions: [string, AprsData][] = [
    ['a PHG power (4.4 would write PHG4230)', position({ phg: { power: 4.4, height: 2, gain: 3, directivity: 0 } })],
    ['a PHG height code', position({ phg: { power: 4, height: 2.5, gain: 3, directivity: 0 } })],
    ['a PHG gain', position({ phg: { power: 4, height: 2, gain: 3.2, directivity: 0 } })],
    ['a PHG directivity', position({ phg: { power: 4, height: 2, gain: 3, directivity: 0.5 } })],
    ['a PHG beacon rate', position({ phg: { power: 4, height: 2, gain: 3, directivity: 0, beaconsPerHour: 2.5 } })],
    ['a DFS strength (1.2)', position({ dfs: { strength: 1.2, height: 2, gain: 3, directivity: 0 } })],
    ['a DFS height code', position({ dfs: { strength: 1, height: 2.5, gain: 3, directivity: 0 } })],
    ['an area offset', position({ area: { shape: 'circle', color: 'red-high', latOffset: 1.5, lonOffset: 2 } })],
    ['a DF bearing code', position({ dfBearing: { bearingDegrees: 90, number: 1.5, range: 2, quality: 3 } })],
    ['a DF bearing', position({ dfBearing: { bearingDegrees: 90.5, number: 1, range: 2, quality: 3 } })],
    ['a storm field (150.5)', position({ symbol: { table: '\\', code: '@' }, storm: { type: 'hurricane', sustainedWindKnots: 150.5, gustKnots: 180, centralPressureMbar: 950, hurricaneRadiusNm: 50, tropicalStormRadiusNm: 100 } })],
    ['a comment telemetry sequence (1.4)', position({ telemetry: { sequence: 1.4, analog: [1, 2, 3] } })],
    ['a comment telemetry value', position({ telemetry: { sequence: 1, analog: [1, 2.5, 3] } })],
    ['comment telemetry bits', position({ telemetry: { sequence: 1, analog: [1, 2, 3, 4, 5], digital: 1.5 } })],
    ['an Agrelo quality (5.3)', { type: 'agrelo-df', bearingDegrees: 90, quality: 5.3 } as AprsData],
  ];
  for (const [what, data] of fractions) {
    it(`refuses ${what} as value-out-of-range, at the top level and inside a third-party packet`, () => {
      expect(code(() => encodeInformation(data))).toBe('value-out-of-range');
      expect(code(() => encodeInformation(nested(data, 2)))).toBe('value-out-of-range');
    });
  }
  it('still rounds a step field once, as the Encoding rule lists them', () => {
    expect(text(encodeInformation(position({ courseDegrees: 88.4, speedKnots: 35.6 })).information)).toBe('!5130.00N/00006.00W>088/036');
    expect(text(encodeInformation({ type: 'agrelo-df', bearingDegrees: 90.4, quality: 5 } as AprsData).information)).toBe('%090/5');
  });
  it('reads back an integer exactly, so bytes whose digit differs are a difference', () => {
    // The comparison on its own: PHG4230 holds power 4, not 4.4.
    const problems = readBack(position({ phg: { power: 4.4, height: 2, gain: 3, directivity: 0 } }), '!5130.00N/00006.00W>PHG4230', undefined);
    expect(problems.map((p) => p.text).join(';')).toContain('phg.power');
    expect(readBack({ type: 'agrelo-df', bearingDegrees: 90, quality: 5.3 } as AprsData, '%090/5', undefined).length).toBeGreaterThan(0);
    expect(readBack(position({ telemetry: { sequence: 1.4, analog: [1, 2, 3] } }), '!5130.00N/00006.00W>|!"!"!#!$|', undefined).length).toBeGreaterThan(0);
  });
});

describe('a Mic-E altitude is held as given and written by the builder in the Mic-E bytes first', () => {
  const build = () => Aprs.from('N0CALL').micE(51.5, -0.5).symbol('/>').micEMessage('en-route').messaging().comment('/A=001234 x').altitudeFeet(1000).build();

  it('keeps the altitude as given on the built packet, rounded to no metre', () => {
    const p = build();
    if (p.data.type !== 'mic-e') throw new Error(p.data.type);
    expect(p.data.altitudeFeet).toBe(1000);
    expect(decodeTnc2(p.toTnc2()).data).toMatchObject({ type: 'mic-e', altitudeFeet: 1000 });
  });
  it('writes the same bytes from the data a caller copies, and from the data itself', () => {
    const p = build();
    expect(text(encodeInformation(p.data).information)).toBe(text(p.information));
    expect(text(encodeInformation({ ...p.data }).information)).toBe(text(p.information));
  });
  it('writes what the caller changes honestly, and leaves the built packet alone', () => {
    const p = build();
    const line = p.toTnc2();
    if (p.data.type !== 'mic-e') throw new Error(p.data.type);
    (p.data as { altitudeFeet: number }).altitudeFeet = 5000;
    expect(decodeTnc2(encodeTnc2({ source: 'N0CALL', data: p.data })).data).toMatchObject({ altitudeFeet: 5000 });
    expect(p.toTnc2()).toBe(line);
  });
  it('writes the Mic-E bytes first for a builder, though neutral data with the same whole feet takes the /A=', () => {
    const built = Aprs.from('N0CALL').micE(51.5, -0.5).symbol('/>').micEMessage('en-route').altitudeFeet(100).build();
    expect(text(built.information)).not.toContain('/A=');
    if (built.data.type !== 'mic-e') throw new Error(built.data.type);
    expect(text(encodeInformation(built.data).information)).toContain('/A=000100');
  });
});

describe('the information field a built packet gives out is a copy', () => {
  it('changes nothing the packet writes when it is changed', () => {
    const p = Aprs.from('N0CALL').status('x').build();
    const line = p.toTnc2();
    const frame = p.toAx25();
    p.information[1] = 0x21;
    p.information.fill(0x0a);
    expect(p.toTnc2()).toBe(line);
    expect(p.toTnc2Bytes()).toEqual(encodeUtf8(line));
    expect(p.toAx25()).toEqual(frame);
    expect(p.toKiss()).toEqual(Aprs.from('N0CALL').status('x').build().toKiss());
  });
  it('is not the array the writers read, nor the one given out before', () => {
    const p = Aprs.from('N0CALL').status('x').build();
    expect(p.information).toEqual(encodeUtf8('>x'));
    expect(p.information.buffer).not.toBe(Aprs.from('N0CALL').status('x').build().information.buffer);
  });
});

describe('empty and absent are one value', () => {
  it('reads null and false in neutral data as absent', () => {
    const data = fromNeutralData({ type: 'position', latitude: 51.5, longitude: -0.1, symbol: '/>', comment: null, messaging: false, course_degrees: null, phg: null, timestamp: null });
    expect(text(encodeInformation(data).information)).toBe('!5130.00N/00006.00W>');
    const message = fromNeutralData({ type: 'message', addressee: 'N0CALL', text: 'hi', message_id: null, reply_ack: null });
    expect(text(encodeInformation(message).information)).toBe(':N0CALL   :hi');
  });
  it('keeps a null in a list as the value it is', () => {
    const data = fromNeutralData({ type: 'telemetry', sequence: '001', analog: [1, null, 3, 4, 5], bits: '00000000' });
    expect(text(encodeInformation(data).information)).toBe('T#001,001,,003,004,005,00000000');
  });
  it('refuses an ack or reject with its ID absent or empty as invalid-message-id', () => {
    expect(code(() => encodeInformation({ type: 'ack', addressee: 'N0CALL' } as unknown as AprsData))).toBe('invalid-message-id');
    expect(code(() => encodeInformation({ type: 'ack', addressee: 'N0CALL', ackedId: '' }))).toBe('invalid-message-id');
    expect(code(() => encodeInformation({ type: 'reject', addressee: 'N0CALL' } as unknown as AprsData))).toBe('invalid-message-id');
    expect(code(() => encodeInformation({ type: 'reject', addressee: 'N0CALL', rejectedId: '' }))).toBe('invalid-message-id');
    expect(code(() => Aprs.from('N0CALL').ack('N0CALL', '').build())).toBe('invalid-message-id');
  });
  it('refuses a builder with an empty message ID or destination, and takes an empty comment as no text', () => {
    expect(code(() => Aprs.from('N0CALL').message('N0CALL', 'hi').messageId('').build())).toBe('invalid-message-id');
    expect(code(() => Aprs.from('N0CALL').to('').status('x').build())).toBe('invalid-address');
    expect(Aprs.from('N0CALL').position(51.5, -0.1).symbol('/>').comment('').build().toTnc2()).toBe(Aprs.from('N0CALL').position(51.5, -0.1).symbol('/>').build().toTnc2());
    expect(text(Aprs.from('N0CALL').micE(51.5, -0.5).symbol('/>').comment('').build().information)).toBe(text(Aprs.from('N0CALL').micE(51.5, -0.5).symbol('/>').build().information));
  });
});

describe('a display conversion is not a writer', () => {
  it('shows a built or held packet without refusing, whatever it holds', () => {
    const held = decodeTnc2('N0CALL>:>a\rb');
    expect(() => String(held)).not.toThrow();
    expect(() => JSON.stringify(held)).not.toThrow();
    expect(() => String(Aprs.from('N0CALL').status('x').build())).not.toThrow();
  });
});

describe('the comparison counts what it must', () => {
  it('refuses a read-back that sees only a warning', () => {
    // Same type, same fields: the one difference is a trailing line break, which decodes with a warning.
    const problems = readBack(status, '>hi\r', undefined);
    expect(problems.map((p) => p.text)).toEqual(['it would read back with warning:trailing-line-break']);
    expect(readBack(status, '>hi', undefined)).toEqual([]);
  });
  it('refuses a warning or an error, even one with the code of a listed info, on the form that info is listed for', () => {
    expect(diagnosticProblems([diagnostic('error', 'invalid-position')], 'position')).toHaveLength(1);
    expect(diagnosticProblems([diagnostic('warning', 'invalid-position')], 'position')).toHaveLength(1);
    expect(diagnosticProblems([diagnostic('warning', 'obsolete-format')], 'maidenhead-beacon')).toHaveLength(1);
    expect(diagnosticProblems([diagnostic('error', 'invalid-query')], 'message')).toHaveLength(1);
    expect(diagnosticProblems([diagnostic('info', 'obsolete-format')], 'maidenhead-beacon')).toHaveLength(0);
  });
  it('refuses an info that is not listed', () => {
    expect(diagnosticProblems([diagnostic('info', 'reserved-data-type')], 'status')).toHaveLength(1);
    expect(diagnosticProblems([diagnostic('info', 'not-aprs')], 'unrecognized')).toHaveLength(1);
  });
  it('accepts each listed info on its own form only', () => {
    const forms: [string, string[]][] = [
      ['obsolete-format', ['weather', 'raw-weather', 'nmea', 'maidenhead-beacon', 'mic-e']],
      ['mic-e-missing-device-type', ['mic-e']],
      ['invalid-query', ['message']],
      ['invalid-telemetry-metadata', ['message']],
    ];
    const types = ['position', 'object', 'item', 'mic-e', 'message', 'status', 'weather', 'raw-weather', 'nmea', 'maidenhead-beacon', 'query', 'telemetry'];
    for (const [info, accepted] of forms) {
      for (const type of types) {
        const n = diagnosticProblems([diagnostic('info', info as never)], type).length;
        expect(n, `${info} on ${type}`).toBe(accepted.includes(type) ? 0 : 1);
      }
    }
  });
  it('refuses a decode with a field the data does not give', () => {
    const problems = readBack({ type: 'position', ...at } as AprsData, '!5130.00N/00006.00W>hello', undefined);
    expect(problems.map((p) => p.text)).toEqual(['comment would appear']);
    expect(readBack({ type: 'position', ...at } as AprsData, '!5130.00N/00006.00W>', undefined)).toEqual([]);
  });
  it('refuses a field the data gives and the decode lacks', () => {
    const problems = readBack({ type: 'position', ...at, comment: 'hello' } as AprsData, '!5130.00N/00006.00W>', undefined);
    expect(problems.map((p) => p.text)).toEqual(['comment would be lost']);
  });
});

describe('the header read back must carry no diagnostic', () => {
  const entry = { address: 'WIDE1-1', used: true };
  const read = (diagnostics: ReturnType<typeof diagnostic>[]) => ({ source: 'N0CALL', destination: 'APZ001', path: [entry], diagnostics });

  it('is clean for a header read back with none', () => {
    expect(headerDifference(read([]), 'N0CALL', 'APZ001', [entry])).toBeUndefined();
  });
  it('refuses a header that reads back with a warning though every address is the same', () => {
    expect(headerDifference(read([diagnostic('warning', 'multiple-used-markers')]), 'N0CALL', 'APZ001', [entry])).toContain('multiple-used-markers');
  });
  it('lets an empty destination carry the diagnostic a held packet has for it, and no other', () => {
    const empty = { source: 'N0CALL', destination: '', path: [], diagnostics: [diagnostic('warning', 'empty-destination')] };
    expect(headerDifference(empty, 'N0CALL', '', [])).toBeUndefined();
    expect(headerDifference({ ...empty, diagnostics: [diagnostic('warning', 'multiple-used-markers')] }, 'N0CALL', '', [])).toContain('multiple-used-markers');
  });
});

describe('a refusal says what is wrong', () => {
  const weather = (extra: unknown): AprsData => ({ type: 'position', ...at, symbol: { table: '/', code: '_' }, weather: { temperatureF: 70, extra } }) as AprsData;

  it('says the extra weather fields are a list when a string is given, and refuses it as malformed', () => {
    expect(code(() => encodeInformation(weather('abc')))).toBe('malformed');
    expect(message(() => encodeInformation(weather('abc')))).toMatch(/list/);
    expect(code(() => encodeInformation(weather([{ letter: 'X', value: 12 }])))).toBe('malformed');
    expect(code(() => encodeInformation(weather([null])))).toBe('malformed');
  });
  it('says a one-character extra is too short, not that it is not digits', () => {
    expect(code(() => encodeInformation(weather([{ letter: 'X', value: '1' }])))).toBe('text-reads-as-field');
    expect(message(() => encodeInformation(weather([{ letter: 'X', value: '1' }])))).toMatch(/one character/);
    expect(message(() => encodeInformation(weather([{ letter: 'X', value: '1a' }])))).toMatch(/digits, dots or -, ending in a digit/);
    expect(message(() => encodeInformation(weather([{ letter: 'c', value: '12' }])))).toMatch(/"c" is not a letter/);
    // Beside a software type and a unit the same fields are written.
    const both = { type: 'position', ...at, symbol: { table: '/', code: '_' }, weather: { temperatureF: 70, software: 'x', unit: 'Dvs', extra: [{ letter: 'X', value: '12' }] } } as AprsData;
    expect(text(encodeInformation(both).information)).toBe('!5130.00N/00006.00W_.../...g...t070X12xDvs');
  });
  it('says which entry is out of order for a path, and never that an entry reads back as itself', () => {
    const why = message(() => Aprs.from('N0CALL').via('WIDE1-1', 'N0CALL-1*').status('x').build());
    expect(why).toContain('"WIDE1-1" is not marked used');
    // A used flag that is truthy but not true is a used entry, not an entry that reads back as itself.
    expect(Aprs.from('N0CALL').via({ address: 'WIDE1-1', used: 1 } as never).status('x').build().toTnc2()).toBe('N0CALL>APZ001,WIDE1-1*:>x');
    expect(encodeTnc2({ source: 'N0CALL', path: [{ address: 'WIDE1-1', used: 1 as never }], data: status })).toBe('N0CALL>APZ001,WIDE1-1*:>hi');
  });
});

describe('a record with thousands of faults costs no more than one with none', () => {
  const weather = (extra: { letter: string; value: string }[]): AprsData => ({ type: 'position', ...at, symbol: { table: '/', code: '_' }, weather: { temperatureF: 70, extra } }) as AprsData;
  const best = (data: AprsData): number => {
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      code(() => encodeInformation(data));
      ms = Math.min(ms, performance.now() - t0);
    }
    return ms;
  };

  it('takes about as long to refuse 200,000 bad extra fields as to refuse as many good ones for size', () => {
    const bad = weather(Array.from({ length: 200_000 }, () => ({ letter: 'c', value: '12' })));
    const good = weather(Array.from({ length: 200_000 }, () => ({ letter: 'X', value: '12' })));
    expect(code(() => encodeInformation(bad))).toBe('text-reads-as-field');
    expect(code(() => encodeInformation(good))).toBe('information-field-too-long');
    // A fault is noted as a record, not as an error with the stack it captures: the ratio was about 7 before.
    expect(best(bad)).toBeLessThan(best(good) * 3 + 20);
  });
});

describe('a voice offset', () => {
  const at2 = (offsetKhz: number): AprsData => ({ type: 'position', latitude: 51.5, longitude: -0.1, symbol: { table: '/', code: '>' }, frequency: { mhz: 146.52, offsetKhz } }) as AprsData;
  it('that is whole kHz and not a multiple of 10 has no form; a fraction is out of range, never rounded', () => {
    expect(code(() => encodeInformation(at2(605)))).toBe('value-has-no-form');
    expect(code(() => encodeInformation(at2(60.5)))).toBe('value-out-of-range');
    expect(code(() => encodeInformation(at2(600)))).toBe('written');
  });
});
