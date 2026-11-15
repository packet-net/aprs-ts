// A sweep (round 5): NaN, both infinities, the largest and smallest finite values, -0, a fraction and
// wrong types go into EVERY numeric field of every data type and every builder argument, at depth 0,
// 1 and 2 of third-party nesting. Each call must refuse with a refusal the rules name (never the
// fallback `does-not-read-back`), or write bytes that decode back equal to the data given; nothing
// else may be thrown, and a number that is not a number is never written.

import { describe, expect, it } from 'vitest';
import { Aprs, AprsEncodeError, encodeInformation, type AprsData } from '../src/index.js';
import { bytesToBinary } from '../src/bytes.js';
import { readBack } from '../src/encode/readback.js';

const sym = { table: '/', code: '>' };
const at = { latitude: 51.5, longitude: -0.1, symbol: sym };
const ts = { kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 };
const inner = (data: unknown, source = 'N0CALL', destination = 'APRS') => ({ source, destination, path: [], information: new Uint8Array(0), data, diagnostics: [] });

/** One base of each shape of data, every numeric field populated. */
const BASES: Record<string, Record<string, unknown>> = {
  'position fields': { type: 'position', ...at, timestamp: ts, courseDegrees: 88, speedKnots: 36, altitudeFeet: 1234, telemetry: { sequence: 5, analog: [1, 2, 3, 4, 5], digital: 7 }, dao: { datum: 'W', precision: 'base91' }, frequency: { mhz: 146.52, tone: 'tone', toneValue: 77, offsetKhz: 600, range: 25 }, comment: 'x' },
  'ambiguous position': { type: 'position', ...at, ambiguity: 2 },
  phg: { type: 'position', ...at, phg: { power: 4, height: 2, gain: 3, directivity: 1, beaconsPerHour: 5 } },
  range: { type: 'position', ...at, rangeMiles: 150 },
  dfs: { type: 'position', ...at, dfs: { strength: 1, height: 2, gain: 3, directivity: 4 } },
  area: { type: 'position', ...at, symbol: { table: '\\', code: 'l' }, area: { shape: 'line-down-right', color: 'red', latOffset: 1, lonOffset: 2, corridorWidthMiles: 5 } },
  'area off a line': { type: 'position', ...at, symbol: { table: '\\', code: 'l' }, area: { shape: 'open-circle', color: 'red', latOffset: 1, lonOffset: 2 } },
  'df bearing': { type: 'position', ...at, symbol: { table: '/', code: '\\' }, courseDegrees: 10, speedKnots: 20, dfBearing: { bearingDegrees: 90, number: 1, range: 2, quality: 3 } },
  storm: { type: 'position', ...at, symbol: { table: '\\', code: '@' }, courseDegrees: 10, speedKnots: 20, storm: { type: 'hurricane', sustainedWindKnots: 100, gustKnots: 120, centralPressureMbar: 950, hurricaneRadiusNm: 50, tropicalStormRadiusNm: 100, wholeGaleRadiusNm: 150 } },
  compressed: { type: 'position', ...at, compressed: true, courseDegrees: 88, speedKnots: 36 },
  'compressed range': { type: 'position', ...at, compressed: true, rangeMiles: 20 },
  'compressed altitude': { type: 'position', ...at, compressed: true, compression: { fix: 'current', source: 'gga', origin: 'software' }, altitudeFeet: 1000 },
  'position weather': { type: 'position', ...at, symbol: { table: '/', code: '_' }, weather: { windDirectionDegrees: 90, windSpeedMph: 5, windGustMph: 8, temperatureF: 70, rain1hIn: 0.1, rain24hIn: 0.2, rainMidnightIn: 0.3, humidityPercent: 50, pressureMbar: 1013.2, luminosityWM2: 300, snow24hIn: 0.5, rainRaw: 12 } },
  'mic-e': { type: 'mic-e', micEMessage: 'en-route', ...at, courseDegrees: 88, speedKnots: 36, altitudeFeet: 100, destinationSsid: 3, legacyTelemetry: [1, 2, 3, 4, 5] },
  object: { type: 'object', name: 'OBJ', timestamp: ts, ...at, courseDegrees: 10, speedKnots: 5 },
  item: { type: 'item', name: 'ITEM', ...at, altitudeFeet: 50 },
  weather: { type: 'weather', timestamp: { kind: 'mdhm', month: 1, day: 2, hour: 3, minute: 4 }, weather: { windDirectionDegrees: 90, windSpeedMph: 5, windGustMph: 8, temperatureF: 70, rain1hIn: 0.1, humidityPercent: 50, pressureMbar: 1013.2, luminosityWM2: 300, snow24hIn: 0.5, rainRaw: 12 } },
  telemetry: { type: 'telemetry', sequence: '001', analog: [1, 2, 3, 4, 5], bits: '00000000' },
  coefficients: { type: 'telemetry-coefficients', addressee: 'N0CALL', coefficients: [0, 1, 0, 0, 1, 0] },
  nmea: { type: 'nmea', sentence: 'GPGLL,4916.45,N,12311.12,W,225444,A,*1D', hasChecksum: true, latitude: 49.274166666666666, longitude: -123.18533333333333, fix: 'valid' },
  'nmea rmc': { type: 'nmea', sentence: 'GPRMC,092204.999,A,4250.5589,S,14718.5084,E,0.00,89.68,211200,,*25', hasChecksum: true, courseDegrees: 89.68, speedKnots: 0 },
  query: { type: 'query', queryType: 'APRS', footprint: { latitude: 51.5, longitude: -0.1, radiusMiles: 100 } },
  agrelo: { type: 'agrelo-df', bearingDegrees: 90, quality: 5 },
  message: { type: 'message', addressee: 'N0CALL', text: 'hi', messageId: '1' },
  status: { type: 'status', timestamp: ts, text: 'hi' },
};

const HOSTILE: unknown[] = [Number.NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -0, 0.5, 1e21, -1, 'x', null, {}, [], true];

/** Every path to a number in the data (skipping the nested third-party packet's header). */
function leaves(value: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (typeof value === 'number') out.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, [...path, i], out));
  else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) for (const [k, v] of Object.entries(value)) leaves(v, [...path, k], out);
  return out;
}

function withValue(base: unknown, path: (string | number)[], v: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>;
  at[path[path.length - 1]!] = v;
  return copy;
}

function wrap(data: unknown, depth: number): unknown {
  let out = data;
  // A Mic-E report's position is half in the destination, so the packet round it takes the one computed.
  let destination = 'APRS';
  if ((data as { type?: unknown }).type === 'mic-e') {
    try {
      destination = encodeInformation(data as AprsData).destination ?? destination;
    } catch {
      // Refused on its own: the sweep reports it.
    }
  }
  for (let i = 0; i < depth; i++) {
    out = { type: 'third-party', packet: inner(out, 'N0CALL', i === 0 ? destination : 'APRS') };
  }
  return out;
}

function hasNonFinite(v: unknown): boolean {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasNonFinite);
  if (typeof v === 'object' && v !== null && !(v instanceof Uint8Array)) return Object.values(v).some(hasNonFinite);
  return false;
}

/** Every miss in one test, so a run shows all of them. */
const misses: string[] = [];

function check(data: unknown, what: string): void {
  try {
    checkOne(data, what);
  } catch (e) {
    misses.push(e instanceof Error ? e.message.split('\n')[0]! : String(e));
  }
}

function checkOne(data: unknown, what: string): void {
  let written: ReturnType<typeof encodeInformation>;
  try {
    written = encodeInformation(data as AprsData);
  } catch (e) {
    if (!(e instanceof AprsEncodeError)) throw new Error(`${what}: threw ${String(e)}`);
    expect(e.code, `${what}: ${e.message}`).not.toBe('does-not-read-back');
    return;
  }
  expect(hasNonFinite(data), `${what}: a number that is not a number was written`).toBe(false);
  // Decoded afresh, as a user would, and compared as the read-back compares.
  expect(readBack(data as AprsData, bytesToBinary(written.information), written.destination), `${what}: does not read back`).toEqual([]);
}

describe('hostile numbers in every numeric field of every type, at three depths', () => {
  for (const [name, base] of Object.entries(BASES)) {
    const paths = leaves(base);
    it(`${name}: ${paths.length} fields`, () => {
      misses.length = 0;
      // The base itself is sound at every depth, so a refusal below is the hostile number's.
      for (const depth of [0, 1, 2]) expect(() => encodeInformation(wrap(base, depth) as AprsData), `${name} at depth ${depth}`).not.toThrow();
      for (const depth of [0, 1, 2]) {
        for (const path of paths) {
          for (const v of HOSTILE) {
            const data = withValue(base, path, v);
            // The inner packet of a nested Mic-E needs its own destination: only its numbers matter here.
            check(wrap(data, depth), `${name} at depth ${depth}, ${path.join('.')} = ${String(v)}`);
          }
        }
      }
      expect([...new Set(misses)].slice(0, 12)).toEqual([]);
    });
  }
});

describe('hostile numbers in every builder argument', () => {
  const b = () => Aprs.from('N0CALL');
  const calls: [string, (v: number) => unknown][] = [
    ['position latitude', (v) => b().position(v, -0.1).symbol('/>').build()],
    ['position longitude', (v) => b().position(51.5, v).symbol('/>').build()],
    ['course', (v) => b().position(51.5, -0.1).symbol('/>').courseDegrees(v).build()],
    ['speed', (v) => b().position(51.5, -0.1).symbol('/>').speedKnots(v).build()],
    ['speed km/h', (v) => b().position(51.5, -0.1).symbol('/>').speedKmh(v).build()],
    ['altitude feet', (v) => b().position(51.5, -0.1).symbol('/>').altitudeFeet(v).build()],
    ['altitude metres', (v) => b().position(51.5, -0.1).symbol('/>').altitudeM(v).build()],
    ['frequency', (v) => b().position(51.5, -0.1).symbol('/>').frequency(v, { tone: 'tone', toneValue: v, offsetKhz: v, range: v }).build()],
    ['telemetry', (v) => b().position(51.5, -0.1).symbol('/>').telemetry(v, [v, v], v).build()],
    ['ambiguity', (v) => b().position(51.5, -0.1).symbol('/>').ambiguity(v).build()],
    ['phg', (v) => b().position(51.5, -0.1).symbol('/>').phg(v, v, v, v, v).build()],
    ['range', (v) => b().position(51.5, -0.1).symbol('/>').rangeMiles(v).build()],
    ['mic-e position', (v) => b().micE(v, v).symbol('/>').courseDegrees(v).speedKnots(v).altitudeFeet(v).build()],
    ['weather', (v) => b().weather({ windDirectionDegrees: v, windSpeedMph: v, windGustMph: v, temperatureF: v, rain1hIn: v, humidityPercent: v, pressureMbar: v, luminosityWM2: v, snow24hIn: v } as never, { latitude: 51.5, longitude: -0.1 }).build()],
    ['weather in metric', (v) => b().weather({ temperatureC: v, rain1hMm: v } as never, { latitude: 51.5, longitude: -0.1 }).build()],
    ['object', (v) => b().object('OBJ', v, v).timestamp(new Date(Date.UTC(2026, 10, 9, 12, 0))).symbol('/>').courseDegrees(v).build()],
    ['item', (v) => b().item('ITEM', v, v).symbol('/>').build()],
    ['telemetry report', (v) => b().telemetry(v, [v, v, v, v, v]).build()],
    ['coefficients', (v) => b().telemetryCoefficients([v, v, v]).build()],
    ['timestamp', (v) => b().position(51.5, -0.1).symbol('/>').timestamp({ kind: 'dhm-zulu', day: v, hour: v, minute: v }).build()],
  ];
  for (const [name, call] of calls) {
    it(name, () => {
      for (const v of HOSTILE) {
        try {
          const p = call(v as number) as { toTnc2(): string; data: unknown };
          expect(hasNonFinite(p.data), `${name} = ${String(v)}: a number that is not a number was built`).toBe(false);
          p.toTnc2();
        } catch (e) {
          if (!(e instanceof AprsEncodeError)) throw new Error(`${name} = ${String(v)}: threw ${String(e)}`);
          expect(e.code, `${name} = ${String(v)}: ${e.message}`).not.toBe('does-not-read-back');
        }
      }
    });
  }
});
