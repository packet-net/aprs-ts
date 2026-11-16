// A held packet whose data, header and information bytes no longer agree is never written, whatever
// kind of data it is and at whatever depth; a packet decoded from bytes and written back unchanged is.

import { describe, expect, it } from 'vitest';
import { AprsEncodeError, decodeTnc2, encodeInformation, encodeTnc2, packetToAx25, packetToTnc2, type AprsData, type AprsPacket } from '../src/index.js';

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

/** The data as a loose record, to change a field of it. */
type Loose = Record<string, unknown> & { packet: Loose; data: Loose };
const loose = (d: unknown): Loose => d as Loose;

const symbol = { table: '/', code: '>' };

describe('a held packet whose data and information field disagree', () => {
  const position = decodeTnc2('N0CALL>APRS:!4903.50N/07201.75W-hi');
  const message_ = decodeTnc2('N0CALL>APRS::BLN1     :text');
  const nested = decodeTnc2('A>APRS:}B>C,TCPIP*:}D>E,TCPIP*:!4903.50N/07201.75W-hi');

  const withData = (p: AprsPacket, data: unknown): AprsPacket => ({ ...p, data: data as AprsData });

  it('writes a decoded packet back unchanged', () => {
    for (const p of [position, message_, nested]) {
      expect(code(() => packetToTnc2(p))).toBe('written');
      expect(code(() => packetToAx25(p))).toBe('written');
    }
  });

  it('refuses a position whose latitude was changed, as a line and as a frame', () => {
    const p = withData(position, { ...position.data, latitude: 10 });
    expect(code(() => packetToTnc2(p))).toBe('not-encodable');
    expect(code(() => packetToAx25(p))).toBe('not-encodable');
    expect(message(() => packetToTnc2(p))).toContain('disagree');
  });

  it('refuses a message whose text was changed', () => {
    expect(code(() => packetToTnc2(withData(message_, { ...message_.data, text: 'other' })))).toBe('not-encodable');
  });

  it('refuses an inner packet whose destination was changed at depth 1', () => {
    const d1 = loose(nested.data).packet;
    const p = withData(nested, { ...nested.data, packet: { ...d1, destination: 'APXX' } });
    expect(code(() => packetToTnc2(p))).toBe('not-encodable');
    expect(code(() => packetToAx25(p))).toBe('not-encodable');
  });

  it('refuses an inner packet whose destination was changed at depth 2, written as data or as a held packet', () => {
    const d1 = loose(nested.data).packet;
    const d2 = loose(d1.data).packet;
    const changed = { ...nested.data, packet: { ...d1, data: { ...d1.data, packet: { ...d2, destination: 'APXX' } } } };
    expect(code(() => packetToTnc2(withData(nested, changed)))).toBe('not-encodable');
    expect(code(() => encodeTnc2({ source: 'A', data: changed as AprsData }))).toBe('not-encodable');
    expect(code(() => encodeTnc2({ source: 'A', data: nested.data }))).toBe('written');
  });

  it('refuses an inner position whose latitude was changed at depth 2', () => {
    const d1 = loose(nested.data).packet;
    const d2 = loose(d1.data).packet;
    const changed = { ...nested.data, packet: { ...d1, data: { ...d1.data, packet: { ...d2, data: { ...d2.data, latitude: 10 } } } } };
    expect(code(() => encodeTnc2({ source: 'A', data: changed as AprsData }))).toBe('not-encodable');
  });
});

describe('a value that is not a number in a numeric field', () => {
  it('is not-a-number, a bigint included', () => {
    for (const v of [10n, '10', {}]) {
      expect(code(() => encodeInformation({ type: 'position', latitude: v, longitude: 1, symbol } as unknown as AprsData))).toBe('not-a-number');
      expect(code(() => encodeInformation({ type: 'agrelo-df', bearingDegrees: v, quality: 1 } as unknown as AprsData))).toBe('not-a-number');
    }
  });

  it('is still missing-field when absent', () => {
    expect(code(() => encodeInformation({ type: 'position', longitude: 1, symbol } as unknown as AprsData))).toBe('missing-field');
  });
});
