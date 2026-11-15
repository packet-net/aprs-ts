// The read-back (vectors README, Rules, Read-back): every call that writes bytes from data ends
// with one read-back, whatever the report. These tests fail if it is removed or skipped for a
// type: data whose naive bytes read back as something else, the choke point itself with the
// read-back forced to fail, the comparison on its own (rounding to the step of the form written
// and nothing looser), and the header.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Aprs,
  AprsEncodeError,
  decodeAx25,
  decodeInformation,
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
import { bytesToHex, encodeUtf8 } from '../src/bytes.js';
import { compareData } from '../src/encode/readback.js';
import { fromNeutralData, toNeutralData, type Neutral } from '../src/neutral.js';

// The read-back, spied on and able to be forced to find a problem.
const control = vi.hoisted(() => ({ force: false, calls: 0 }));
vi.mock('../src/encode/readback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/encode/readback.js')>();
  return {
    ...actual,
    readBack: (...args: Parameters<typeof actual.readBack>) => {
      control.calls++;
      return control.force ? [{ code: 'does-not-read-back' as const, text: 'forced by the test' }] : actual.readBack(...args);
    },
  };
});

beforeEach(() => {
  control.force = false;
  control.calls = 0;
});

const symbol = { table: '/', code: '>' };
const at = { latitude: 51.5, longitude: -0.1, symbol };
const inner = { source: 'N0CALL', destination: 'APZ001', path: [], information: new Uint8Array(0), data: { type: 'status', text: 'x' }, diagnostics: [] };

/** One well-formed example of every data type that can be written. */
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
  // Reports with weather, and each way of writing a position.
  { type: 'position', ...at, symbol: { table: '/', code: '_' }, weather: { temperatureF: 70, pressureMbar: 1013.2 } },
  { type: 'position', ...at, compressed: true, courseDegrees: 88, speedKnots: 36 },
  { type: 'mic-e', micEMessage: 'en-route', ...at, speedKnots: 10, courseDegrees: 90, altitudeFeet: 100 },
];

function refusal(data: unknown): string | undefined {
  try {
    encodeInformation(data as AprsData);
  } catch (e) {
    if (e instanceof AprsEncodeError) return e.code;
    throw e;
  }
  return undefined;
}

function written(data: unknown): string {
  const e = encodeInformation(data as AprsData);
  return Buffer.from(e.information).toString('latin1');
}

describe('the read-back ends every information field written', () => {
  it('has an example of every type that can be written', () => {
    const types = new Set(EXAMPLES.map((e) => e.type));
    // Everything but undecoded data, which has nothing to write.
    expect([...types].sort()).toEqual(
      [
        'ack', 'agrelo-df', 'bulletin', 'capabilities', 'directed-query', 'item', 'maidenhead-beacon', 'message', 'mic-e', 'nmea', 'nws-bulletin',
        'object', 'position', 'query', 'raw-weather', 'reject', 'status', 'telemetry', 'telemetry-bits', 'telemetry-coefficients', 'telemetry-names',
        'telemetry-units', 'test', 'third-party', 'user-defined', 'weather',
      ].sort(),
    );
  });

  for (const [i, example] of EXAMPLES.entries()) {
    it(`reads back ${String(example.type)} (example ${i}) once, and refuses when the read-back finds a change`, () => {
      expect(refusal(example)).toBeUndefined();
      // Third-party packets read back the outer packet (and an inner one written from data, its own).
      expect(control.calls).toBeGreaterThanOrEqual(1);
      control.force = true;
      control.calls = 0;
      // Whatever the type, bytes that failed the read-back are never returned.
      expect(refusal(example)).toBe('does-not-read-back');
      expect(control.calls).toBeGreaterThanOrEqual(1);
    });
  }

  it('reads back before the size is judged: bytes that fail get the read-back code, never the size one', () => {
    control.force = true;
    expect(refusal({ type: 'status', text: 'x'.repeat(300) })).toBe('does-not-read-back');
    control.force = false;
    expect(refusal({ type: 'status', text: 'x'.repeat(300) })).toBe('information-field-too-long');
  });

  it('is run by the packet writers on the information field and on the header', () => {
    for (const write of [encodeTnc2, encodeTnc2Bytes, encodeAx25]) {
      control.force = true;
      expect(() => write({ source: 'N0CALL', data: { type: 'status', text: 'hi' } })).toThrow(AprsEncodeError);
      control.force = false;
      expect(() => write({ source: 'N0CALL', data: { type: 'status', text: 'hi' } })).not.toThrow();
    }
    control.force = true;
    expect(() => Aprs.from('N0CALL').status('hi').build()).toThrow(AprsEncodeError);
  });
});

describe('data whose naive bytes read back as something else is written in an equivalent form, or refused', () => {
  // A comment that reads as another field when it follows the position straight on.
  const course = '090/005g010t072';
  const withComment = { latitude: 51.5, longitude: -0.5, symbol, comment: course };

  it('position: the comment goes after a /', () => {
    expect(written({ type: 'position', ...withComment })).toBe('!5130.00N/00030.00W>/090/005g010t072');
  });
  it('object: the comment goes after a /', () => {
    expect(written({ type: 'object', name: 'OBJ', timestamp: { kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 }, ...withComment })).toBe(
      ';OBJ      *092345z5130.00N/00030.00W>/090/005g010t072',
    );
  });
  it('item: the comment goes after a /', () => {
    expect(written({ type: 'item', name: 'ITEM', ...withComment })).toBe(')ITEM!5130.00N/00030.00W>/090/005g010t072');
  });
  it('mic-e: status text that reads as a locator is written so that it reads back as text', () => {
    const data = { type: 'mic-e', micEMessage: 'en-route', latitude: 51.5, longitude: -0.5, symbol, speedKnots: 10, typeCode: '`', comment: 'IO91SX/G' };
    const e = encodeInformation(data as AprsData);
    const again = decodeInformation(e.information, e.destination!);
    expect(toNeutralData(again.data).comment).toBe('IO91SX/G');
    expect(toNeutralData(again.data).locator).toBeUndefined();
    expect(bytesToHex(e.information).toLowerCase()).toBe('60763a1c6d201c3e2f602f494f393153582f47');
  });
  it('position with weather: a field of an extra letter that reads as one already read is refused', () => {
    expect(refusal({ type: 'position', ...at, symbol: { table: '/', code: '_' }, weather: { pressureMbar: 1013.2, extra: [{ letter: 's', value: '012' }] } })).toBe('text-reads-as-field');
  });
  it('positionless weather: a software type and unit that read as a field are refused', () => {
    const timestamp = { kind: 'mdhm', month: 10, day: 9, hour: 23, minute: 45 };
    expect(refusal({ type: 'weather', timestamp, weather: { temperatureF: 70, software: 'r', unit: '001p' } })).toBe('text-reads-as-field');
  });
  it('message, bulletin and NWS bulletin: text that reads as an ack is refused', () => {
    expect(refusal({ type: 'message', addressee: 'N0CALL', text: 'ack1' })).toBe('text-reads-as-field');
    expect(refusal({ type: 'bulletin', addressee: 'BLN1', text: 'ack1' })).toBe('text-reads-as-field');
    expect(refusal({ type: 'nws-bulletin', addressee: 'NWS-WARN', text: 'ack1' })).toBe('text-reads-as-field');
  });
  it('status: text that reads as a timestamp is refused', () => {
    expect(refusal({ type: 'status', text: '092345z' })).toBe('text-reads-as-field');
  });
  it('telemetry names, units, coefficients, bits and a directed query to a bulletin addressee are refused', () => {
    expect(refusal({ type: 'telemetry-names', addressee: 'BLN1', names: ['A'] })).toBe('text-reads-as-field');
    expect(refusal({ type: 'telemetry-units', addressee: 'BLN1', units: ['V'] })).toBe('text-reads-as-field');
    expect(refusal({ type: 'telemetry-coefficients', addressee: 'BLN1', coefficients: [0, 1, 0] })).toBe('text-reads-as-field');
    expect(refusal({ type: 'telemetry-bits', addressee: 'BLN1', bits: '11111111' })).toBe('text-reads-as-field');
    expect(refusal({ type: 'directed-query', addressee: 'BLN1', queryType: 'APRSD' })).toBe('text-reads-as-field');
  });
  it('third-party: the inner packet written from data is read back too', () => {
    const packet = { ...inner, path: [{ address: 'TCPIP', used: true }], data: { type: 'position', ...withComment } };
    expect(written({ type: 'third-party', packet })).toBe('}N0CALL>APZ001,TCPIP*:!5130.00N/00030.00W>/090/005g010t072');
    expect(refusal({ type: 'third-party', packet: { ...inner, data: { type: 'status', text: '092345z' } } })).toBe('text-reads-as-field');
  });
  it('empty and absent are one value: an empty message ID is no message ID, an empty target no target', () => {
    expect(written({ type: 'message', addressee: 'N0CALL', text: 'hi', messageId: '' })).toBe(':N0CALL   :hi');
    expect(written({ type: 'directed-query', addressee: 'N0CALL', queryType: 'APRSP', target: '' })).toBe(':N0CALL   :?APRSP');
  });
  it('a weather software type goes with its unit', () => {
    const w = (weather: object): unknown => ({ type: 'position', ...at, symbol: { table: '/', code: '_' }, weather });
    expect(refusal(w({ temperatureF: 70, software: 'x' }))).toBe('missing-field');
    expect(refusal(w({ temperatureF: 70, unit: 'RSW' }))).toBe('missing-field');
  });
});

describe('the comparison reads numbers as the form written holds them', () => {
  const ok = (want: object, got: object, data?: object): string[] => compareData(want as Neutral, got as Neutral, data as AprsData | undefined).map((p) => p.text);

  const p = (extra: object): object => ({ type: 'position', symbol: '/>', ...extra });

  it('compares a position to the hundredth of a minute, not within a tolerance', () => {
    // 51.123456 degrees is 51 degrees 7.40736 minutes: 7.41, which is 51.1235 degrees.
    const read = 51 + 7.41 / 60;
    expect(ok(p({ latitude: 51.123456, longitude: 0 }), p({ latitude: read, longitude: 0 }))).toEqual([]);
    // One step off, and the 1e-4 degrees the old comparison allowed.
    expect(ok(p({ latitude: 51.123456, longitude: 0 }), p({ latitude: read + 1 / 6000, longitude: 0 }))).not.toEqual([]);
    expect(ok(p({ latitude: 51.5, longitude: 0 }), p({ latitude: 51.5 + 5e-5, longitude: 0 }))).not.toEqual([]);
  });
  it('compares a compressed position to its base-91 step', () => {
    const lat = 90 - Math.round(380926 * (90 - 51.123456)) / 380926;
    const lon = -180 + Math.round(190463 * (180 + 0.1)) / 190463;
    const base = { compressed: true, compression: { fix: 'current', source: 'other', origin: 'software' } };
    expect(ok(p({ ...base, latitude: 51.123456, longitude: 0.1 }), p({ ...base, latitude: lat, longitude: lon }))).toEqual([]);
    expect(ok(p({ ...base, latitude: 51.123456, longitude: 0.1 }), p({ ...base, latitude: lat + 1 / 380926, longitude: lon }))).not.toEqual([]);
  });
  it('compares an ambiguous position with the centre of the box that holds it', () => {
    // 51 degrees 24.0 minutes, two digits blanked: the box 24 to 25 minutes, centre 24.5.
    const want = p({ latitude: 51.4, longitude: 0, ambiguity: 2 });
    expect(ok(want, p({ latitude: 51 + 24.5 / 60, longitude: 0.5 / 60, ambiguity: 2 }))).toEqual([]);
    expect(ok(want, p({ latitude: 51.4, longitude: 0.5 / 60, ambiguity: 2 }))).not.toEqual([]);
  });
  it('compares a !DAO! position to its thousandth of a minute', () => {
    const dao = { datum: 'W', precision: 'thousandths' };
    const lat = 51 + 7.407 / 60;
    expect(ok(p({ latitude: 51.123456, longitude: 0, dao }), p({ latitude: lat, longitude: 0, dao }))).toEqual([]);
    expect(ok(p({ latitude: 51.123456, longitude: 0, dao }), p({ latitude: 51 + 7.41 / 60, longitude: 0, dao }))).not.toEqual([]);
  });
  it('reads north in cs bytes as a course of 360 and a wind direction of 0', () => {
    const base = { compressed: true, latitude: 1, longitude: 1, compression: { fix: 'current', source: 'other', origin: 'software' } };
    const speed = Math.pow(1.08, 20) - 1;
    expect(ok(p({ ...base, course_degrees: 1, speed_knots: speed }), p({ ...base, course_degrees: 360, speed_knots: speed }))).toEqual([]);
    expect(ok(p({ ...base, course_degrees: 3, speed_knots: speed }), p({ ...base, course_degrees: 4, speed_knots: speed }))).toEqual([]);
    expect(ok(p({ ...base, course_degrees: 3, speed_knots: speed }), p({ ...base, course_degrees: 8, speed_knots: speed }))).not.toEqual([]);
    const wx = (w: object): object => p({ ...base, symbol: '/_', weather: w });
    expect(ok(wx({ wind_direction_degrees: 360, wind_speed_mph: 0 }), wx({ wind_direction_degrees: 0, wind_speed_mph: 0 }))).toEqual([]);
  });
  it('compares whole units uncompressed, and a course of 2 degrees off is a difference', () => {
    const base = { latitude: 1, longitude: 1 };
    expect(ok(p({ ...base, course_degrees: 88.4, speed_knots: 36.6 }), p({ ...base, course_degrees: 88, speed_knots: 37 }))).toEqual([]);
    expect(ok(p({ ...base, course_degrees: 88.4, speed_knots: 36.6 }), p({ ...base, course_degrees: 90, speed_knots: 37 }))).not.toEqual([]);
    expect(ok(p({ ...base, course_degrees: 88, speed_knots: 36 }), p({ ...base, course_degrees: 88, speed_knots: 36.3 }))).not.toEqual([]);
  });
  it('compares a Mic-E altitude in whole metres, and a /A= in whole feet', () => {
    const mice = { type: 'mic-e', latitude: 1, longitude: 1 };
    const metres = 31 / 0.3048;
    expect(ok({ ...mice, altitude_feet: 100.5 }, { ...mice, altitude_feet: metres })).toEqual([]);
    expect(ok({ ...mice, altitude_feet: 100.5 }, { ...mice, altitude_feet: 100.5 })).not.toEqual([]);
    expect(ok(p({ latitude: 1, longitude: 1, altitude_feet: 100.5 }), p({ latitude: 1, longitude: 1, altitude_feet: 101 }))).toEqual([]);
    expect(ok(p({ latitude: 1, longitude: 1, altitude_feet: 100.5 }), p({ latitude: 1, longitude: 1, altitude_feet: 100 }))).not.toEqual([]);
  });
  it('compares weather to its steps: hundredths of an inch, tenths of a millibar, snowfall in three forms', () => {
    const w = (weather: object): object => ({ type: 'weather', weather });
    expect(ok(w({ rain_1h_in: 0.126, pressure_mbar: 1013.24, snow_24h_in: 2.46 }), w({ rain_1h_in: 0.13, pressure_mbar: 1013.2, snow_24h_in: 2.5 }))).toEqual([]);
    expect(ok(w({ rain_1h_in: 0.126 }), w({ rain_1h_in: 0.12 }))).not.toEqual([]);
    expect(ok(w({ snow_24h_in: 0.995 }), w({ snow_24h_in: 1 }))).toEqual([]);
    expect(ok(w({ snow_24h_in: 12.4 }), w({ snow_24h_in: 12.4 }))).not.toEqual([]);
    expect(ok(w({ snow_24h_in: 12.4 }), w({ snow_24h_in: 12 }))).toEqual([]);
  });
  it('compares a voice frequency to its kilohertz, or 10 kilohertz', () => {
    const f = (frequency: object): object => p({ latitude: 1, longitude: 1, frequency });
    expect(ok(f({ mhz: 146.5204 }), f({ mhz: 146.52 }))).toEqual([]);
    expect(ok(f({ mhz: 146.5204 }), f({ mhz: 146.521 }))).not.toEqual([]);
    expect(ok(f({ mhz: 146.524, ten_khz_resolution: true }), f({ mhz: 146.52, ten_khz_resolution: true }))).toEqual([]);
  });
  it('compares telemetry values, coefficients, footprint coordinates and NMEA fields without steps, within 1e-9', () => {
    expect(ok({ type: 'telemetry', analog: [1.5] }, { type: 'telemetry', analog: [1.5 + 1e-12] })).toEqual([]);
    expect(ok({ type: 'telemetry', analog: [1.5] }, { type: 'telemetry', analog: [2] })).not.toEqual([]);
    expect(ok({ type: 'telemetry-coefficients', coefficients: [0.53] }, { type: 'telemetry-coefficients', coefficients: [1] })).not.toEqual([]);
    const q = (latitude: number): object => ({ type: 'query', footprint: { latitude, longitude: 1, radius_miles: 200 } });
    expect(ok(q(34.04), q(34))).not.toEqual([]);
    expect(ok({ type: 'nmea', sentence: 'X', latitude: 1.5 }, { type: 'nmea', sentence: 'X', latitude: 1.6 })).not.toEqual([]);
  });
  it('allows only the value the form must carry: exactly the default compression type, a Mic-E speed of 0', () => {
    const base = { latitude: 1, longitude: 1, compressed: true, course_degrees: 4, speed_knots: 0 };
    const dflt = { fix: 'current', source: 'other', origin: 'software' };
    expect(ok(p(base), p({ ...base, compression: dflt }))).toEqual([]);
    expect(ok(p(base), p({ ...base, compression: { ...dflt, fix: 'old' } }))).not.toEqual([]);
    expect(ok(p(base), p({ ...base, compression: { ...dflt, source: 'gga' } }))).not.toEqual([]);
    expect(ok({ type: 'mic-e', latitude: 1, longitude: 1 }, { type: 'mic-e', latitude: 1, longitude: 1, speed_knots: 0 })).toEqual([]);
    expect(ok({ type: 'mic-e', latitude: 1, longitude: 1 }, { type: 'mic-e', latitude: 1, longitude: 1, speed_knots: 1 })).not.toEqual([]);
    expect(ok({ type: 'status', text: 'x' }, { type: 'status', text: 'x', locator: 'IO91' })).not.toEqual([]);
  });
  it('compares at every depth and in both directions', () => {
    const inner = (comment: string | undefined): object => ({ type: 'third-party', packet: { source: 'A', destination: 'B', data: { type: 'status', text: comment } } });
    expect(ok(inner('a'), inner('a'))).toEqual([]);
    expect(ok(inner('a'), inner('b'))).not.toEqual([]);
    expect(ok(inner('a'), inner(undefined))).not.toEqual([]);
    expect(ok(inner(undefined), inner('a'))).not.toEqual([]);
  });
});

describe('the header is read back as it is written', () => {
  const path = (...entries: [string, boolean][]) => entries.map(([address, used]) => ({ address, used }));
  const unusedBeforeUsed = path(['WIDE1-1', false], ['N0CALL-1', true]);
  const status = { type: 'status', text: 'hi' } as AprsData;

  it('writes * on the last used entry only, and both read back used', () => {
    const both = path(['WIDE1-1', true], ['N0CALL-1', true], ['WIDE2-1', false]);
    const line = encodeTnc2({ source: 'N0CALL', path: both, data: status });
    expect(line).toBe('N0CALL>APZ001,WIDE1-1,N0CALL-1*,WIDE2-1:>hi');
    expect(decodeTnc2(line).path).toEqual(both);
    const frame = encodeAx25({ source: 'N0CALL', path: both, data: status });
    expect(decodeAx25(frame).path).toEqual(both);
    // The H bit is on both used entries.
    expect(frame[7 * 2 + 6]! & 0x80).toBe(0x80);
    expect(frame[7 * 3 + 6]! & 0x80).toBe(0x80);
  });
  it('accepts a * on a station path entry as a used entry, on the builder too', () => {
    expect(Aprs.from('N0CALL').via('WIDE1-1*', 'N0CALL-1*', 'WIDE2-1').status('hi').build().toTnc2()).toBe('N0CALL>APZ001,WIDE1-1,N0CALL-1*,WIDE2-1:>hi');
    expect(encodeTnc2({ source: 'N0CALL', path: ['N0CALL-1*', 'WIDE2-1'], data: status })).toBe('N0CALL>APZ001,N0CALL-1*,WIDE2-1:>hi');
  });
  it('refuses an entry before a used one that is not marked: tnc2-cannot-carry as a line, ax25-cannot-carry as a frame', () => {
    const code = (f: () => unknown): string | undefined => {
      try {
        f();
      } catch (e) {
        return (e as AprsEncodeError).code;
      }
      return undefined;
    };
    expect(code(() => encodeTnc2({ source: 'N0CALL', path: unusedBeforeUsed, data: status }))).toBe('tnc2-cannot-carry');
    expect(code(() => encodeTnc2Bytes({ source: 'N0CALL', path: unusedBeforeUsed, data: status }))).toBe('tnc2-cannot-carry');
    expect(code(() => encodeAx25({ source: 'N0CALL', path: unusedBeforeUsed, data: status }))).toBe('ax25-cannot-carry');
    const built = Aprs.from('N0CALL').via('WIDE1-1').status('hi').build();
    expect(built.toTnc2()).toBe('N0CALL>APZ001,WIDE1-1:>hi');
    const bad = Aprs.from('N0CALL').via({ address: 'WIDE1-1', used: false } as never, 'N0CALL-1*').status('hi').build();
    expect(code(() => bad.toTnc2())).toBe('tnc2-cannot-carry');
    expect(code(() => bad.toTnc2Bytes())).toBe('tnc2-cannot-carry');
    expect(code(() => bad.toAx25())).toBe('ax25-cannot-carry');
    expect(code(() => bad.toKiss())).toBe('ax25-cannot-carry');
  });
  it('checks the header a pass-through writer writes, and writes the information field as received', () => {
    const received = decodeTnc2('N0CALL>APZ001,WIDE1-1,N0CALL-1*:>hi\x07 odd');
    expect(packetToTnc2(received)).toBe('N0CALL>APZ001,WIDE1-1,N0CALL-1*:>hi\x07 odd');
    expect(decodeAx25(packetToAx25(received)).path).toEqual(received.path);
    const held: AprsPacket = { ...received, path: unusedBeforeUsed };
    expect(() => packetToTnc2Bytes(held)).toThrow(AprsEncodeError);
    expect(() => packetToTnc2(held)).toThrow(/cannot carry/);
    expect(() => packetToAx25(held)).toThrow(AprsEncodeError);
    // The information field is not re-encoded: a received field over 256 bytes is written as it came.
    const long = decodeTnc2(encodeUtf8(`N0CALL>APZ001:>${'x'.repeat(300)}`));
    expect(packetToTnc2Bytes(long).length).toBe('N0CALL>APZ001:'.length + 301);
  });
});

describe('what the comparison is given is checked on the data, not on the types', () => {
  it('round-trips neutral data of every example through the comparison with no difference', () => {
    for (const example of EXAMPLES) {
      const data = example as unknown as AprsData;
      const bytes = encodeInformation(data);
      const decoded = decodeInformation(bytes.information, bytes.destination ?? 'APZ001');
      expect(compareData(toNeutralData(data), toNeutralData(decoded.data), decoded.data)).toEqual([]);
      expect(fromNeutralData(toNeutralData(decoded.data)).type).toBe(data.type);
    }
  });
});

describe('a data fault comes before a header the form cannot carry (R25)', () => {
  const tooLongObject = (p: ReturnType<typeof Aprs.from>) => p.object('TOOLONGNAME', 1, 2).timestamp(new Date('2026-09-27T09:23:45Z'), 'dhm-zulu');

  it('refuses the data first when building, whatever the path or call', () => {
    expect(() => tooLongObject(Aprs.from('N0CALL').via('WIDE1-1', 'N0CALL-1*')).build()).toThrow(expect.objectContaining({ code: 'invalid-name' }));
    expect(() => tooLongObject(Aprs.from('N0CALLXYZ')).build()).toThrow(expect.objectContaining({ code: 'invalid-name' }));
  });

  it('builds sound data with a header one form cannot carry, and refuses it when written', () => {
    const built = Aprs.from('N0CALLXYZ').status('hi').build();
    expect(built.toTnc2()).toBe('N0CALLXYZ>APZ001:>hi');
    expect(() => built.toAx25()).toThrow(expect.objectContaining({ code: 'ax25-cannot-carry' }));
  });
});

describe('a held packet with an empty destination', () => {
  it('is written empty in a line and as six spaces in a frame, which read back the same', () => {
    const packet = decodeTnc2('N0CALL>:>x');
    expect(packetToTnc2(packet)).toBe('N0CALL>:>x');
    expect(bytesToHex(packetToAx25(packet)).slice(0, 14).toLowerCase()).toBe('404040404040e0');
    expect(decodeAx25(packetToAx25(packet)).destination).toBe('');
  });
});

describe('a builder message ID that is empty is refused, neutral data that is empty is no ID', () => {
  it('refuses a builder with invalid-message-id', () => {
    expect(() => Aprs.from('N0CALL').message('N0CALL', 'hi').messageId('').build()).toThrow(expect.objectContaining({ code: 'invalid-message-id' }));
    expect(() => Aprs.from('N0CALL').message('N0CALL', 'hi').messageId('').replyAck('').build()).toThrow(expect.objectContaining({ code: 'invalid-message-id' }));
  });
  it('writes neutral data with an empty ID as no ID, and refuses it beside a reply-ack', () => {
    expect(new TextDecoder().decode(encodeInformation({ type: 'message', addressee: 'N0CALL', text: 'hi', messageId: '' }).information)).toBe(':N0CALL   :hi');
    expect(() => encodeInformation({ type: 'message', addressee: 'N0CALL', text: 'hi', messageId: '', replyAck: '' })).toThrow(expect.objectContaining({ code: 'missing-field' }));
  });
});

describe('a Mic-E altitude takes a /A= when the comment holds one and the /A= holds it exactly', () => {
  it('writes the bytes first, then a /A= for a builder, and refuses what no form holds', () => {
    const built = Aprs.from('N0CALL').micE(51.5, -0.5).symbol('/>').micEMessage('en-route').altitudeFeet(1000).comment('/A=001234 x').build();
    expect(new TextDecoder().decode(built.information)).toContain('/A=001000//A=001234 x');
    expect(() => Aprs.from('N0CALL').micE(51.5, -0.5).symbol('/>').micEMessage('en-route').altitudeFeet(100.5).comment('/A=001234 x').build()).toThrow(expect.objectContaining({ code: 'text-reads-as-field' }));
  });
});

describe('a third-party packet', () => {
  it('writes an inner packet that carries warnings as received: they are data, read back with it', () => {
    const inner = decodeTnc2('A>B:@092345z4903.50n/07201.75w>');
    expect(inner.diagnostics.filter((d) => d.severity === 'warning').length).toBe(2);
    const written = encodeInformation({ type: 'third-party', packet: inner });
    expect(new TextDecoder().decode(written.information)).toBe('}A>B:@092345z4903.50n/07201.75w>');
    // Neutral data without the warnings is checked by the rules first, and would read back with them.
    expect(() => encodeInformation({ type: 'third-party', packet: { ...inner, information: new Uint8Array(0), diagnostics: [] } })).not.toThrow();
  });
});
