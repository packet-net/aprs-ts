// Data built by hand, which the type system does not check: every public encoding call refuses it
// with an AprsEncodeError and a reason code, never with another error.

import { describe, expect, it } from 'vitest';
import { Aprs, AprsEncodeError, encodeAx25, encodeInformation, encodeTnc2, packetToAx25, packetToTnc2, type AprsData } from '../src/index.js';
import { fromNeutralData, toNeutralData } from '../src/neutral.js';

const symbol = { table: '/', code: '-' };
const at = { latitude: 49.5, longitude: -72.75, symbol };
const inner = { source: 'N0CALL', destination: 'APZ001', path: [], information: new Uint8Array(0), data: { type: 'status', text: 'x' }, diagnostics: [] };

/** One well-formed example of every data type, with every field its type always has. */
const EXAMPLES: Record<string, unknown>[] = [
  { type: 'position', ...at },
  { type: 'object', name: 'OBJ', timestamp: { kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 }, ...at },
  { type: 'item', name: 'ITEM', ...at },
  { type: 'mic-e', micEMessage: 'en-route', ...at },
  { type: 'message', addressee: 'N0CALL', text: 'hi' },
  { type: 'ack', addressee: 'N0CALL', ackedId: '1' },
  { type: 'reject', addressee: 'N0CALL', rejectedId: '1' },
  { type: 'bulletin', addressee: 'BLN1', text: 'hi' },
  { type: 'nws-bulletin', addressee: 'NWS-WARN', text: 'hi' },
  { type: 'telemetry-names', addressee: 'N0CALL', names: ['A'] },
  { type: 'telemetry-units', addressee: 'N0CALL', units: ['V'] },
  { type: 'telemetry-coefficients', addressee: 'N0CALL', coefficients: [0, 1, 0] },
  { type: 'telemetry-bits', addressee: 'N0CALL', bits: '11111111' },
  { type: 'directed-query', addressee: 'N0CALL', queryType: 'APRSD' },
  { type: 'status', text: 'hi' },
  { type: 'telemetry', sequence: '001', analog: [1, 2, 3, 4, 5], bits: '00000000' },
  { type: 'weather', timestamp: { kind: 'mdhm', month: 1, day: 2, hour: 3, minute: 4 }, weather: { windDirectionDegrees: 0, windSpeedMph: 0, windGustMph: 0, temperatureF: 50 } },
  { type: 'raw-weather', format: 'peet-bros-hash', data: '00' },
  { type: 'nmea', sentence: 'GPGLL,4916.45,N,12311.12,W,225444,A' },
  { type: 'maidenhead-beacon', locator: 'IO91' },
  { type: 'query', queryType: 'APRS' },
  { type: 'capabilities', capabilities: [['IGATE']] },
  { type: 'third-party', packet: inner },
  { type: 'user-defined', userId: 'X', packetType: 'Y', data: 'z' },
  { type: 'test', data: 'x' },
  { type: 'agrelo-df', bearingDegrees: 90, quality: 5 },
];

const ABSENT_TEXT: Record<string, string> = {
  name: 'invalid-name',
  addressee: 'invalid-addressee',
  queryType: 'invalid-code',
  symbol: 'invalid-symbol',
};

function outcome(step: () => unknown): string {
  try {
    step();
    return 'written';
  } catch (e) {
    if (e instanceof AprsEncodeError) return e.code;
    return `threw ${String(e)}`;
  }
}

describe('hand-built data', () => {
  for (const example of EXAMPLES) {
    for (const key of Object.keys(example).filter((k) => k !== 'type')) {
      it(`${example.type} with no ${key} is refused, not thrown`, () => {
        const data = { ...example };
        delete data[key];
        const got = outcome(() => encodeInformation(data as unknown as AprsData));
        expect(got).not.toMatch(/^threw/);
        if (key in ABSENT_TEXT) expect(got).toBe(ABSENT_TEXT[key]);
        for (const f of [encodeTnc2, encodeAx25]) expect(outcome(() => f({ source: 'N0CALL', data: data as unknown as AprsData }))).not.toMatch(/^threw/);
      });
    }
  }

  it('refuses fields of the wrong kind, and a symbol that is an empty object, without throwing', () => {
    expect(outcome(() => encodeInformation({ type: 'position', latitude: 1, longitude: 1, symbol: {} } as unknown as AprsData))).toBe('invalid-symbol');
    for (const example of EXAMPLES) {
      for (const key of Object.keys(example).filter((k) => k !== 'type')) {
        for (const wrong of [null, 7, 'x', {}, [], true]) {
          const data = { ...example, [key]: wrong };
          expect(outcome(() => encodeInformation(data as unknown as AprsData)), `${example.type}.${key} = ${JSON.stringify(wrong)}`).not.toMatch(/^threw/);
        }
      }
    }
    for (const wrong of [null, 7, 'x', [], {}, { type: 'nonsense' }]) expect(outcome(() => encodeInformation(wrong as unknown as AprsData))).not.toMatch(/^threw/);
  });

  it('refuses an inner packet with a field missing, and a packet with no path, without throwing', () => {
    for (const key of Object.keys(inner)) {
      const packet: Record<string, unknown> = { ...inner };
      delete packet[key];
      expect(outcome(() => encodeInformation({ type: 'third-party', packet } as unknown as AprsData))).toBe('missing-field');
      expect(outcome(() => packetToTnc2(packet as never))).not.toMatch(/^threw/);
      expect(outcome(() => packetToAx25(packet as never))).not.toMatch(/^threw/);
    }
  });
});

describe('third-party nesting', () => {
  function nested(levels: number): AprsData {
    let data: AprsData = { type: 'status', text: 'hi' };
    for (let i = 0; i < levels; i++) data = { type: 'third-party', packet: { ...inner, data } } as AprsData;
    return data;
  }

  it('writes four levels and refuses five or more as invalid-third-party-header', () => {
    expect(outcome(() => encodeInformation(nested(4)))).toBe('written');
    for (const levels of [5, 6, 3000]) expect(outcome(() => encodeInformation(nested(levels)))).toBe('invalid-third-party-header');
  });

  it('refuses a caller-built chain 10,000 deep, and converts it to and from the neutral form, without recursing', () => {
    const deep = nested(10_000);
    expect(outcome(() => encodeInformation(deep))).toBe('invalid-third-party-header');
    expect(outcome(() => encodeTnc2({ source: 'N0CALL', data: deep }))).toBe('invalid-third-party-header');
    const neutral = toNeutralData(deep);
    expect(outcome(() => encodeInformation(fromNeutralData(neutral)))).toBe('invalid-third-party-header');
  });
});

describe('the header comes first', () => {
  it('refuses a bad source before a fault in the data, in the builders and the packet encoders', () => {
    expect(outcome(() => Aprs.from('BAD!!').position(49.5, -72.75).courseDegrees(999).speedKnots(1).build())).toBe('invalid-address');
    expect(outcome(() => Aprs.from('BAD!!').micE(49.5, -72.75).courseDegrees(999).speedKnots(1).build())).toBe('invalid-address');
    const bad = { type: 'position', ...at, courseDegrees: 999, speedKnots: 1 } as unknown as AprsData;
    expect(outcome(() => encodeTnc2({ source: 'BAD!!', data: bad }))).toBe('invalid-address');
    expect(outcome(() => encodeAx25({ source: 'TOOLONGCALL', data: bad }))).toBe('ax25-cannot-carry');
    expect(outcome(() => Aprs.from('M0LTE').position(49.5, -72.75).courseDegrees(999).speedKnots(1).build())).toBe('value-out-of-range');
  });
});

describe('a missing field does not jump the Refusal reasons order', () => {
  it('names an earlier-ranked fault elsewhere in the record first', () => {
    expect(outcome(() => encodeInformation({ type: 'message', addressee: 'TOOLONGCALL' } as unknown as AprsData))).toBe('invalid-addressee');
    expect(outcome(() => encodeInformation({ type: 'position', longitude: 1, symbol: { table: 'x', code: '-' } } as unknown as AprsData))).toBe('invalid-symbol');
    expect(outcome(() => encodeInformation({ type: 'telemetry', sequence: '001', comment: 'a\rb' } as unknown as AprsData))).toBe('invalid-character');
    expect(outcome(() => encodeInformation({ type: 'third-party', packet: { ...inner, source: undefined, destination: 'B!', data: { type: 'status', text: 'x' } } } as unknown as AprsData))).toBe('invalid-third-party-header');
    // With nothing else wrong, the missing field is named.
    expect(outcome(() => encodeInformation({ type: 'message', addressee: 'N0CALL' } as unknown as AprsData))).toBe('missing-field');
    expect(outcome(() => encodeInformation({ type: 'position', longitude: 1, symbol } as unknown as AprsData))).toBe('missing-field');
  });
});
