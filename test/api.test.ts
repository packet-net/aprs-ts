// The public API beyond the conformance vectors: the builder, symbols, options, AX.25 and KISS.

import { describe, expect, it } from 'vitest';
import {
  acceptsOverlay,
  AprsEncodeError,
  AprsHeaderError,
  Aprs,
  bytesToHex,
  decodeAx25,
  decodeKiss,
  decodeTnc2,
  decodeUtf8,
  describeSymbol,
  encodeAx25,
  encodeInformation,
  formatDiagnostic,
  identifyTocall,
  isTolerable,
  overlayOf,
  ParseOptions,
  symbolName,
  symbolOf,
  Symbols,
  toNeutralData,
  TOLERABLE_CODES,
  withOverlay,
  withoutOverlay,
  wrapKiss,
} from '../src/index.js';

describe('builder', () => {
  it('builds a position report', () => {
    const packet = Aprs.from('M0LTE-9')
      .via('WIDE1-1', 'WIDE2-1')
      .position(51.45, -0.98)
      .symbol(Symbols.car)
      .course(88)
      .speed(36)
      .comment('Mobile')
      .build();
    expect(packet.toTnc2()).toBe('M0LTE-9>APZ001,WIDE1-1,WIDE2-1:!5127.00N/00058.80W>088/036Mobile');
    expect(packet.destination).toBe('APZ001');
    const back = decodeTnc2(packet.toTnc2());
    expect(back.data.type).toBe('position');
    expect(back.diagnostics).toEqual([]);
  });

  it('builds a timestamped, messaging position with altitude and a frequency', () => {
    const line = Aprs.from('M0LTE')
      .to('APZTS1')
      .position(49.05833333333333, -72.02916666666667)
      .symbol('/>')
      .timestamp({ kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 })
      .messaging()
      .altitude(1234)
      .frequency(146.52, { tone: 'tone', toneValue: 100 })
      .comment('Hello')
      .toTnc2();
    expect(line).toBe('M0LTE>APZTS1:@092345z4903.50N/07201.75W>/A=001234146.520MHz T100 Hello');
  });

  it('builds a compressed position with an overlay', () => {
    const packet = Aprs.from('M0LTE').position(51.45, -0.98).symbol(withOverlay(Symbols.gateway, 'I')).compressed().comment('IGate').build();
    const back = decodeTnc2(packet.toTnc2());
    expect(back.data).toMatchObject({ type: 'position', compressed: true, symbol: { table: 'I', code: '&' }, comment: 'IGate' });
  });

  it('builds a Mic-E report and computes its destination', () => {
    const packet = Aprs.from('N0CALL')
      .micE(33.42733333333334, -112.129)
      .symbol(Symbols.jeep)
      .micEMessage('returning')
      .course(251)
      .speed(20)
      .build();
    expect(packet.destination).toBe('S32UVT');
    const back = decodeTnc2(packet.toTnc2());
    expect(back.data).toMatchObject({ type: 'mic-e', micEMessage: 'returning', courseDegrees: 251, speedKnots: 20 });
  });

  it('builds an object, a killed item, a message, an ack, status, weather and telemetry', () => {
    expect(
      Aprs.from('M0LTE')
        .object('LEADER', 49.05833333333333, -72.02916666666667)
        .timestamp({ kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 })
        .symbol(Symbols.car)
        .course(88)
        .speed(36)
        .toTnc2(),
    ).toBe('M0LTE>APZ001:;LEADER   *092345z4903.50N/07201.75W>088/036');
    expect(Aprs.from('M0LTE').item('AID #2', 49.05833333333333, -72.02916666666667).symbol('/A').killed().toTnc2()).toBe(
      'M0LTE>APZ001:)AID #2_4903.50N/07201.75WA',
    );
    expect(Aprs.from('M0LTE').message('WU2Z', 'Testing').id('003').toTnc2()).toBe('M0LTE>APZ001::WU2Z     :Testing{003');
    expect(Aprs.from('M0LTE').message('WU2Z', 'Hello').id(12).replyAck('34').toTnc2()).toBe('M0LTE>APZ001::WU2Z     :Hello{12}34');
    expect(Aprs.from('M0LTE').ack('KB2ICI-14', '003').toTnc2()).toBe('M0LTE>APZ001::KB2ICI-14:ack003');
    expect(Aprs.from('M0LTE').reject('KB2ICI-14', '003').toTnc2()).toBe('M0LTE>APZ001::KB2ICI-14:rej003');
    expect(Aprs.from('M0LTE').status('Net Control Center').timestamp({ kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 }).toTnc2()).toBe(
      'M0LTE>APZ001:>092345zNet Control Center',
    );
    expect(Aprs.from('M0LTE').status('My house').locator('io91sx', Symbols.house).toTnc2()).toBe('M0LTE>APZ001:>IO91SX/- My house');
    expect(
      Aprs.from('M0LTE')
        .weather(49.05833333333333, -72.02916666666667, { windDirectionDegrees: 220, windSpeedMph: 4, windGustMph: 5, temperatureF: 77 })
        .toTnc2(),
    ).toBe('M0LTE>APZ001:!4903.50N/07201.75W_220/004g005t077');
    expect(Aprs.from('M0LTE').telemetry(5, [199, 0, 255, 73, 123], '01101001').toTnc2()).toBe(
      'M0LTE>APZ001:T#005,199,000,255,073,123,01101001',
    );
    expect(Aprs.from('M0LTE').telemetryNames('M0LTE', ['Battery', 'Temp']).toTnc2()).toBe('M0LTE>APZ001::M0LTE    :PARM.Battery,Temp');
    expect(Aprs.from('M0LTE').bulletin('1', 'Net tonight at 8').toTnc2()).toBe('M0LTE>APZ001::BLN1     :Net tonight at 8');
  });

  it('refuses what the spec does not allow, and says why', () => {
    expect(() => Aprs.from('M0LTE').message('N0CALL', 'x'.repeat(68)).build()).toThrow(AprsEncodeError);
    expect(() => Aprs.from('M0LTE').position(51, 0).comment('/A=001234').build()).toThrow(/read back/);
    expect(() => Aprs.from('M0LTE').object('OR4F ', 51, 2).build()).toThrow(/space/);
    expect(() => Aprs.from('M0LTE').position(91, 0).build()).toThrow(/latitude/);
  });

  it('writes AX.25 and KISS frames', () => {
    const packet = Aprs.from('M0LTE-9').via('WIDE2-1').status('hello').build();
    const frame = packet.toAx25();
    expect(bytesToHex(frame)).toBe('82A0B4606062E0' + '9A6098A88A4072' + 'AE92888A644063' + '03F0' + '3E68656C6C6F');
    expect(decodeAx25(frame).data).toEqual({ type: 'status', text: 'hello' });
    expect(decodeKiss(packet.toKiss()).source).toBe('M0LTE-9');
    expect(bytesToHex(wrapKiss(Uint8Array.of(0xc0, 0xdb)))).toBe('C000DBDCDBDDC0');
  });
});

describe('symbols', () => {
  it('names every symbol', () => {
    expect(Symbols.car).toEqual({ table: '/', code: '>' });
    expect(symbolName(symbolOf('/_'))).toBe('weatherStation');
    expect(describeSymbol(Symbols.car)).toBe('Car');
    expect(Object.keys(Symbols).length).toBeGreaterThan(160);
  });

  it('puts overlays on alternate-table symbols that take one', () => {
    const igate = withOverlay(Symbols.gateway, 'I');
    expect(igate).toEqual({ table: 'I', code: '&' });
    expect(overlayOf(igate)).toBe('I');
    expect(withoutOverlay(igate)).toEqual(Symbols.gateway);
    expect(acceptsOverlay(igate)).toBe(true);
    expect(describeSymbol(igate)).toBe(describeSymbol(Symbols.gateway));
    expect(() => withOverlay(Symbols.car, '3')).toThrow(RangeError);
    expect(() => withOverlay(Symbols.gateway, 'i')).toThrow(RangeError);
  });
});

describe('options and diagnostics', () => {
  it('tolerates each tolerable code on its own', () => {
    const line = 'N1EOE>APN391:!4216.95n/07243.20w#';
    expect(decodeTnc2(line).diagnostics.map(formatDiagnostic)).toEqual(['warning:lowercase-hemisphere', 'warning:lowercase-hemisphere']);
    expect(decodeTnc2(line, ParseOptions.strict).data).toEqual({ type: 'unrecognized', reason: 'malformed' });
    expect(decodeTnc2(line, ParseOptions.strict.with('lowercase-hemisphere')).data.type).toBe('position');
    expect(decodeTnc2(line, ParseOptions.lenient.without('lowercase-hemisphere')).data.type).toBe('unrecognized');
    expect(TOLERABLE_CODES.every(isTolerable)).toBe(true);
    expect(() => ParseOptions.lenient.with('truncated' as never)).toThrow(RangeError);
  });

  it('throws for an unusable header', () => {
    expect(() => decodeTnc2('no header at all')).toThrow(AprsHeaderError);
    try {
      decodeTnc2('N0 CALL>APZ001:>hi');
    } catch (e) {
      expect((e as AprsHeaderError).diagnostics.map(formatDiagnostic)).toEqual(['error:invalid-address']);
    }
  });

  it('identifies devices', () => {
    expect(identifyTocall('APDW18')).toMatchObject({ vendor: 'WB2OSZ', model: 'DireWolf' });
    expect(decodeTnc2('N1JCM-9>TRQP7T:`c\'wl|+>/`"4-}_%').device).toMatchObject({ vendor: 'Yaesu', model: 'FTM-400DR' });
  });

  it('keeps the hemisphere of a zero coordinate', () => {
    const packet = decodeTnc2('N0CALL>APZ001:!0000.00N\\00000.00W.');
    expect(Object.is((packet.data as { longitude: number }).longitude, -0)).toBe(true);
    expect(decodeUtf8(encodeInformation(packet.data).info)).toBe('!0000.00N\\00000.00W.');
    expect(toNeutralData(packet.data).longitude).toBe(-0);
  });

  it('round-trips a frame through the encoder', () => {
    const frame = encodeAx25({ source: 'M0LTE', path: ['WIDE1-1'], data: { type: 'status', text: 'x' } });
    expect(decodeAx25(frame).path).toEqual([{ address: 'WIDE1-1', used: false }]);
  });
});

describe('raw NMEA', () => {
  const rmc = 'GPRMC,204717,A,3242.4549,N,08527.2835,W,000,340,090207,,*0C';

  it('reads the text after the checksum as a comment, and writes it back', () => {
    const packet = decodeTnc2(`WB4BYQ-3>APT311:$${rmc}/Home Station by TinyTrack`);
    expect(packet.data).toMatchObject({ type: 'nmea', sentence: rmc, hasChecksum: true, comment: '/Home Station by TinyTrack' });
    expect(decodeUtf8(encodeInformation(packet.data).info)).toBe(`$${rmc}/Home Station by TinyTrack`);
  });

  it('refuses a comment with no checksum to end the sentence, and fields the sentence does not say', () => {
    const noChecksum = { type: 'nmea', sentence: 'GPGLL,2554.459,N,08020.187,W,154027.281,A', comment: 'x' } as const;
    expect(() => encodeInformation(noChecksum)).toThrow(AprsEncodeError);
    const wrongLatitude = { type: 'nmea', sentence: rmc, hasChecksum: true, latitude: 10, longitude: -85.454725 } as const;
    expect(() => encodeInformation(wrongLatitude)).toThrow(AprsEncodeError);
  });
});

describe('encoder refusals no conformance case pins', () => {
  it('refuses a capability that would not read back the same', () => {
    expect(() => encodeInformation({ type: 'capabilities', capabilities: [['IG ATE']] })).toThrow(AprsEncodeError);
    expect(() => encodeInformation({ type: 'capabilities', capabilities: [['IGATE', '43 ']] })).toThrow(AprsEncodeError);
    expect(decodeUtf8(encodeInformation({ type: 'capabilities', capabilities: [['IGATE', '4 3']] }).info)).toBe('<IGATE=4 3');
  });

  it('pads an APRSH target to 9 characters and writes a target after an undefined type after a space', () => {
    const aprsh = { type: 'directed-query', addressee: 'KH2Z', queryType: 'APRSH', target: 'N0QBF' } as const;
    expect(decodeUtf8(encodeInformation(aprsh).info)).toBe(':KH2Z     :?APRSHN0QBF    ');
    const other = { ...aprsh, queryType: 'FOO' };
    expect(decodeUtf8(encodeInformation(other).info)).toBe(':KH2Z     :?FOO N0QBF');
  });

  it('refuses an ERP code of 0 and a third-party inner packet whose header was defective', () => {
    const status = { type: 'status', text: 'Net', beam: { headingCode: 'B', powerCode: '0' } } as const;
    expect(() => encodeInformation(status)).toThrow(AprsEncodeError);
    const inner = decodeTnc2('N0CALL>APZ001:}N0CALL>APZ,WIDE1-1*,WIDE2-1*:>x');
    expect(() => encodeInformation(inner.data)).toThrow(AprsEncodeError);
  });
});
