// The public API beyond the conformance vectors: the builder, symbols, options, AX.25 and KISS.

import { describe, expect, it } from 'vitest';
import {
  acceptsOverlay,
  AprsEncodeError,
  REFUSAL_CODES,
  REFUSAL_MEANINGS,
  type RefusalCode,
  AprsHeaderError,
  Aprs,
  decodeAx25,
  decodeInformation,
  decodeKiss,
  decodeTnc2,
  describeSymbol,
  encodeAx25,
  encodeInformation,
  formatDiagnostic,
  hasErrors,
  hasWarnings,
  packetToAx25,
  packetToTnc2,
  phgValues,
  identifyTocall,
  isTolerable,
  overlayOf,
  ParseOptions,
  symbolName,
  symbolOf,
  Symbols,
  TOLERABLE_CODES,
  withOverlay,
  withoutOverlay,
  wrapKiss,
  type WeatherInput,
} from '../src/index.js';
import { bytesToHex, decodeUtf8, encodeUtf8 } from '../src/bytes.js';
import { toNeutralData } from '../src/neutral.js';

describe('builder', () => {
  it('builds a position report', () => {
    const packet = Aprs.from('M0LTE-9')
      .via('WIDE1-1', 'WIDE2-1')
      .position(51.45, -0.98)
      .symbol(Symbols.car)
      .courseDegrees(88)
      .speedKnots(36)
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
      .altitudeFeet(1234)
      .frequency(146.52, { tone: 'tone', toneValue: 100 })
      .comment('Hello')
      .toTnc2();
    expect(line).toBe('M0LTE>APZTS1:@092345z4903.50N/07201.75W>146.520MHz T100/A=001234 Hello');
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
      .courseDegrees(251)
      .speedKnots(20)
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
        .courseDegrees(88)
        .speedKnots(36)
        .toTnc2(),
    ).toBe('M0LTE>APZ001:;LEADER   *092345z4903.50N/07201.75W>088/036');
    expect(Aprs.from('M0LTE').item('AID #2', 49.05833333333333, -72.02916666666667).symbol('/A').killed().toTnc2()).toBe(
      'M0LTE>APZ001:)AID #2_4903.50N/07201.75WA',
    );
    expect(Aprs.from('M0LTE').message('WU2Z', 'Testing').messageId('003').toTnc2()).toBe('M0LTE>APZ001::WU2Z     :Testing{003');
    expect(Aprs.from('M0LTE').message('WU2Z', 'Hello').messageId(12).replyAck('34').toTnc2()).toBe('M0LTE>APZ001::WU2Z     :Hello{12}34');
    expect(Aprs.from('M0LTE').ack('KB2ICI-14', '003').toTnc2()).toBe('M0LTE>APZ001::KB2ICI-14:ack003');
    expect(Aprs.from('M0LTE').reject('KB2ICI-14', '003').toTnc2()).toBe('M0LTE>APZ001::KB2ICI-14:rej003');
    expect(Aprs.from('M0LTE').status('Net Control Center').timestamp({ kind: 'dhm-zulu', day: 9, hour: 23, minute: 45 }).toTnc2()).toBe(
      'M0LTE>APZ001:>092345zNet Control Center',
    );
    expect(Aprs.from('M0LTE').status('My house').locator('io91sx', Symbols.house).toTnc2()).toBe('M0LTE>APZ001:>IO91SX/- My house');
    expect(
      Aprs.from('M0LTE')
        .weather({ windDirectionDegrees: 220, windSpeedMph: 4, windGustMph: 5, temperatureF: 77 }, { latitude: 49.05833333333333, longitude: -72.02916666666667 })
        .toTnc2(),
    ).toBe('M0LTE>APZ001:!4903.50N/07201.75W_220/004g005t077');
    expect(Aprs.from('M0LTE').telemetry(5, [199, 0, 255, 73, 123], '01101001').toTnc2()).toBe(
      'M0LTE>APZ001:T#005,199,000,255,073,123,01101001',
    );
    expect(Aprs.from('M0LTE').telemetryNames(['Battery', 'Temp']).toTnc2()).toBe('M0LTE>APZ001::M0LTE    :PARM.Battery,Temp');
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
    expect(decodeUtf8(encodeInformation(packet.data).information)).toBe('!0000.00N\\00000.00W.');
    expect(toNeutralData(packet.data).longitude).toBe(-0);
  });

  it('reads a q-construct only in the outer header, not in a third-party packet', () => {
    const packet = decodeTnc2('N0CALL>APZ001:}N1CALL>APZ001,WIDE2-1,qAR,N2CALL:>hello');
    expect(packet.qConstruct).toBeUndefined();
    if (packet.data.type !== 'third-party') throw new Error(`decoded as ${packet.data.type}`);
    expect(packet.data.packet.qConstruct).toBeUndefined();
    expect(packet.data.packet.path.map((e) => e.address)).toEqual(['WIDE2-1', 'qAR', 'N2CALL']);
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
    expect(decodeUtf8(encodeInformation(packet.data).information)).toBe(`$${rmc}/Home Station by TinyTrack`);
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
    expect(decodeUtf8(encodeInformation({ type: 'capabilities', capabilities: [['IGATE', '4 3']] }).information)).toBe('<IGATE=4 3');
  });

  it('pads an APRSH target to 9 characters and writes a target after an undefined type after a space', () => {
    const aprsh = { type: 'directed-query', addressee: 'KH2Z', queryType: 'APRSH', target: 'N0QBF' } as const;
    expect(decodeUtf8(encodeInformation(aprsh).information)).toBe(':KH2Z     :?APRSHN0QBF    ');
    const other = { ...aprsh, queryType: 'FOO' };
    expect(decodeUtf8(encodeInformation(other).information)).toBe(':KH2Z     :?FOO N0QBF');
  });

  it('refuses an ERP code of 0 and a third-party inner packet whose header was defective', () => {
    const status = { type: 'status', text: 'Net', beam: { headingCode: 'B', powerCode: '0' } } as const;
    expect(() => encodeInformation(status)).toThrow(AprsEncodeError);
    const inner = decodeTnc2('N0CALL>APZ001:}N0CALL>APZ,WIDE1-1*,WIDE2-1*:>x');
    expect(() => encodeInformation(inner.data)).toThrow(AprsEncodeError);
  });
});

describe('device identification (vectors rulings, A1, A2)', () => {
  it('matches a tocall case-sensitively', () => {
    expect(identifyTocall('APN102')).toBeDefined();
    expect(identifyTocall('APNl02')).toBeUndefined();
  });

  it('identifies an inner packet by its own destination', () => {
    const p = decodeTnc2('N0CALL>APRS:}K1ABC>APDW18,TCPIP,N0CALL*:>hello');
    if (p.data.type !== 'third-party') throw new Error(p.data.type);
    expect(p.data.packet.device?.model).toBe('DireWolf');
  });
});

describe('Mic-E ambiguity (vectors README, Mic-E)', () => {
  it('writes the reported centre into the longitude digits', () => {
    const encoded = encodeInformation({
      type: 'mic-e',
      micEMessage: 'off-duty',
      latitude: 41.5,
      longitude: -95.3825,
      ambiguity: 2,
      symbol: { table: '/', code: '>' },
    });
    const p = decodeTnc2(`N0CALL>${encoded.destination}:${decodeUtf8(encoded.information)}`);
    // 95 degrees 22.95 minutes, two digits blanked: the box 22.xx, centre 22.50.
    expect(encoded.information[2]! - 28).toBe(22);
    expect(encoded.information[3]! - 28).toBe(50);
    if (p.data.type !== 'mic-e') throw new Error(p.data.type);
    expect(p.data.longitude).toBeCloseTo(-(95 + 22.5 / 60), 9);
  });
});

describe('builder rulings (vectors rulings, B1, B2, B6)', () => {
  const info = (line: string): string => line.slice(line.indexOf(':') + 1);

  it('takes a course of 0 as unknown', () => {
    expect(info(Aprs.from('N0CALL').position(49.5, -72.75).courseDegrees(0).speedKnots(10).toTnc2())).toBe('!4930.00N/07245.00W/000/010');
    const micE = Aprs.from('N0CALL').micE(49.5, -72.75).courseDegrees(0.3).speedKnots(10).build();
    const back = decodeTnc2(micE.toTnc2());
    if (back.data.type !== 'mic-e') throw new Error(back.data.type);
    expect(back.data.courseDegrees).toBeUndefined();
    expect(() => Aprs.from('N0CALL').position(49.5, -72.75).courseDegrees(0).speedKnots(10).compressed().build()).toThrow(AprsEncodeError);
  });

  it('puts Mic-E metres in the Mic-E altitude bytes and feet in a /A=', () => {
    const metres = Aprs.from('N0CALL').micE(49.5, -72.75).altitudeM(100.4).build();
    expect(decodeUtf8(metres.information)).toContain('"4{}');
    const feet = Aprs.from('N0CALL').micE(49.5, -72.75).altitudeFeet(0).build();
    expect(decodeUtf8(feet.information)).toContain('/A=000000');
  });

  it('converts Celsius and millimetres', () => {
    const line = Aprs.from('N0CALL').weather({ windDirectionDegrees: 90, windSpeedMph: 5, temperatureC: 20.3, rain1hMm: 2.54 }, { latitude: 49.5, longitude: -72.75 }).toTnc2();
    expect(info(line)).toBe('!4930.00N/07245.00W_090/005g...t069r010');
    expect(() => Aprs.from('N0CALL').weather({ temperatureC: 20, temperatureF: 68 } as unknown as WeatherInput, { latitude: 49.5, longitude: -72.75 }).build()).toThrow(AprsEncodeError);
  });

  it('refuses a telemetry sequence over 999', () => {
    expect(info(Aprs.from('N0CALL').telemetry(7, [1, 2, 3, 4, 5], '00000000').toTnc2())).toBe('T#007,001,002,003,004,005,00000000');
    expect(() => Aprs.from('N0CALL').telemetry(1000, [1, 2, 3, 4, 5], '00000000').build()).toThrow(AprsEncodeError);
  });
});

describe('Mic-E status text (vectors README, Mic-E)', () => {
  it('lifts a PHG after a locator before looking for an altitude', () => {
    const p = decodeTnc2('N0CALL>S32UVT:`(_fn"Oj/`IO91SX/G PHG1060}AB');
    if (p.data.type !== 'mic-e') throw new Error(p.data.type);
    expect(p.data.locator).toBe('IO91SX');
    expect(p.data.phg).toEqual({ power: 1, height: 0, gain: 6, directivity: 0 });
    expect(p.data.altitudeFeet).toBeUndefined();
    expect(p.data.comment).toBe('}AB');
    expect(p.diagnostics).toEqual([]);
  });
});

describe('ambiguity cut (vectors rulings, G2)', () => {
  it('takes a value within 1e-6 of the box edge as on it', () => {
    const line = Aprs.from('N0CALL').position(80.49, -72.75).ambiguity(1).toTnc2();
    expect(line.slice(line.indexOf(':') + 1)).toBe('!8029.4 N/07245.0 W/');
  });
});

describe('run 2 rulings', () => {
  it('writes a Mic-E comment that a / would join into an altitude after a space (E12)', () => {
    const line = Aprs.from('N0CALL').micE(49.5, -72.75).comment('/{}').toTnc2();
    expect(line.endsWith('` /{}')).toBe(true);
    const back = decodeTnc2(line);
    if (back.data.type !== 'mic-e') throw new Error(back.data.type);
    expect(back.data.comment).toBe('/{}');
    expect(back.data.altitudeFeet).toBeUndefined();
  });

  it('gives a third-party inner compressed range the default compression type', () => {
    const encoded = encodeInformation({
      type: 'third-party',
      packet: {
        source: 'K1ABC',
        destination: 'APRS',
        path: [],
        information: new Uint8Array(0),
        data: { type: 'position', latitude: 49.5, longitude: -72.75, symbol: { table: '/', code: '>' }, compressed: true, rangeMiles: 20 },
        diagnostics: [],
      },
    });
    expect(decodeUtf8(encoded.information)).toBe('}K1ABC>APRS:!/5L!!<*e8>{?C');
  });
});

describe('1.0 API', () => {
  it('checks the header addresses in build(), and keeps the path as entries', () => {
    expect(() => Aprs.from('M0LTE').to('BAD DEST').status('x').build()).toThrow(AprsEncodeError);
    expect(() => Aprs.from('TOO-LONG-CALL').status('x').build()).toThrow(AprsEncodeError);
    const packet = Aprs.from('M0LTE').via('WIDE1-1*', { address: 'WIDE2-1', used: false }).status('x').build();
    expect(packet.path).toEqual([
      { address: 'WIDE1-1', used: true },
      { address: 'WIDE2-1', used: false },
    ]);
    expect(packet.toTnc2()).toBe('M0LTE>APZ001,WIDE1-1*,WIDE2-1:>x');
  });

  it('refuses a weather value in two units, in the type and at build()', () => {
    // @ts-expect-error a temperature in both units does not compile
    const clash: WeatherInput = { temperatureF: 61, temperatureC: 16 };
    expect(() => Aprs.from('M0LTE').weather(clash).build()).toThrow(AprsEncodeError);
    const ok: WeatherInput = { temperatureC: 16, rain1hMm: 1 };
    expect(ok.temperatureC).toBe(16);
    // a decoded Weather is still a WeatherInput
    const decoded = decodeTnc2('M0LTE>APZ001:!5127.00N/00058.80W_220/004g005t061');
    if (decoded.data.type !== 'position' || !decoded.data.weather) throw new Error('no weather');
    expect(Aprs.from('M0LTE').weather(decoded.data.weather, { latitude: 51.45, longitude: -0.98 }).toTnc2()).toContain('_220/004g005t061');
  });

  it('builds weather with and without a position from one method', () => {
    const at = new Date(Date.UTC(2026, 10, 10, 12, 30));
    expect(Aprs.from('M0LTE').weather({ temperatureF: 61 }, { at }).toTnc2()).toBe('M0LTE>APZ001:_11101230c...s...g...t061');
    expect(Aprs.from('M0LTE').weather({ temperatureF: 61 }, { latitude: 51.45, longitude: -0.98 }).toTnc2()).toBe(
      'M0LTE>APZ001:!5127.00N/00058.80W_.../...g...t061',
    );
  });

  it('takes the telemetry metadata addressee last, defaulting to the station', () => {
    expect(Aprs.from('M0LTE').telemetryUnits(['V', 'C'], 'G4ABC').toTnc2()).toBe('M0LTE>APZ001::G4ABC    :UNIT.V,C');
    expect(Aprs.from('M0LTE').telemetryCoefficients([0, 1, 0]).toTnc2()).toBe('M0LTE>APZ001::M0LTE    :EQNS.0,1,0');
    expect(Aprs.from('M0LTE').telemetryBits('11111111', 'Project').toTnc2()).toBe('M0LTE>APZ001::M0LTE    :BITS.11111111,Project');
  });

  it('keeps where a Mic-E altitude was written in the data', () => {
    const built = Aprs.from('N0CALL').micE(49.5, -72.75).altitudeFeet(100).build();
    if (built.data.type !== 'mic-e') throw new Error(built.data.type);
    expect(built.data.altitudeInComment).toBe(true);
    const copy = encodeInformation({ ...built.data });
    expect(decodeUtf8(copy.information)).toBe(decodeUtf8(built.information));
    const decoded = decodeTnc2(built.toTnc2());
    if (decoded.data.type !== 'mic-e') throw new Error(decoded.data.type);
    expect(decoded.data.altitudeInComment).toBe(true);
    const metres = decodeTnc2(Aprs.from('N0CALL').micE(49.5, -72.75).altitudeM(100).toTnc2());
    if (metres.data.type !== 'mic-e') throw new Error(metres.data.type);
    expect(metres.data.altitudeInComment).toBeUndefined();
  });

  it('writes a received packet back as received', () => {
    const line = 'N1EOE>APN391,N1NCI-3*,WIDE2-1:!4216.95N/07243.20W#PHG6230 Easthampton MA';
    const packet = decodeTnc2(line);
    expect(packetToTnc2(packet)).toBe(line);
    expect(decodeAx25(packetToAx25(packet)).path).toEqual(packet.path);
    expect(hasErrors(packet)).toBe(false);
    expect(hasWarnings(packet)).toBe(false);
    if (packet.data.type !== 'position' || !packet.data.phg) throw new Error('no phg');
    expect(phgValues(packet.data.phg)).toEqual({ powerWatts: 36, heightFeet: 40, gainDb: 3, directivityDegrees: null });
    expect(hasWarnings(decodeTnc2('N1EOE>APN391:!4216.95n/07243.20w#'))).toBe(true);
    expect(() => packetToAx25(decodeTnc2('WB4APR-00>APRS:>x'))).toThrow(AprsEncodeError);
  });

  it('defaults the options of decodeInformation', () => {
    const decoded = decodeInformation(encodeUtf8('>hello'), 'APRS');
    expect(decoded.data).toEqual({ type: 'status', text: 'hello' });
  });

  describe('refusal codes', () => {
    const codeOf = (fn: () => unknown): RefusalCode => {
      try {
        fn();
      } catch (e) {
        if (e instanceof AprsEncodeError) return e.code;
        throw e;
      }
      throw new Error('not refused');
    };
    const info = (data: Parameters<typeof encodeInformation>[0]): (() => unknown) => () => encodeInformation(data);
    const sym = { table: '/', code: '>' };

    it('lists 26 codes with a meaning each', () => {
      expect(REFUSAL_CODES).toHaveLength(26);
      for (const c of REFUSAL_CODES) expect(REFUSAL_MEANINGS[c].length).toBeGreaterThan(0);
    });

    it('names the reason for a representative refusal from each group', () => {
      const pos = { type: 'position', latitude: 51, longitude: -1, symbol: sym } as const;
      expect(codeOf(info({ ...pos, latitude: 91 }))).toBe('value-out-of-range');
      expect(codeOf(info({ ...pos, symbol: { table: '!', code: '>' } }))).toBe('invalid-symbol');
      expect(codeOf(info({ ...pos, comment: 'a\nb' }))).toBe('invalid-character');
      expect(codeOf(info({ type: 'message', addressee: '', text: 'x' }))).toBe('invalid-addressee');
      expect(codeOf(info({ type: 'message', addressee: 'N0CALL', text: 'x', messageId: '123456' }))).toBe('invalid-message-id');
      expect(codeOf(info({ type: 'message', addressee: 'N0CALL', text: 'x'.repeat(68) }))).toBe('too-long');
      expect(codeOf(info({ type: 'status', text: 'x', locator: 'ZZ99', symbol: sym }))).toBe('malformed');
      expect(codeOf(info({ type: 'object', name: 'OBJ', symbol: sym, latitude: 51, longitude: -1 } as never))).toBe('missing-field');
      expect(codeOf(info({ type: 'object', name: 'OBJ ', timestamp: { kind: 'dhm-zulu', day: 1, hour: 1, minute: 1 }, symbol: sym, latitude: 51, longitude: -1 } as never))).toBe('padding-space');
      expect(codeOf(info({ type: 'unrecognized', reason: 'x', raw: 'x' } as never))).toBe('not-encodable');
    });

    it('reports the first-ranked of several faults', () => {
      // A bad addressee comes before a text that is too long, and a missing ID before neither.
      expect(codeOf(info({ type: 'message', addressee: 'A:B', text: 'x'.repeat(68) }))).toBe('invalid-addressee');
      expect(codeOf(info({ type: 'message', addressee: 'NWS-WARN', text: 'x' }))).toBe('invalid-addressee');
      expect(codeOf(info({ type: 'message', addressee: 'N0CALL', text: 'x', replyAck: '1' }))).toBe('missing-field');
      expect(codeOf(info({ type: 'telemetry', sequence: 'MIC', analog: [null, 1, 2, 3, 4], bits: '01010101' }))).toBe('value-has-no-form');
      expect(codeOf(info({ type: 'capabilities', capabilities: [['A B']] } as never))).toBe('malformed');
    });

    it('names AX.25 and TNC2 refusals', () => {
      expect(codeOf(() => encodeAx25({ source: 'TOOLONGCALL', destination: 'APRS', path: [], data: { type: 'status', text: 'x' } } as never))).toBe('ax25-cannot-carry');
      expect(codeOf(() => packetToAx25(decodeTnc2('WB4APR-00>APRS:>x')))).toBe('ax25-cannot-carry');
    });

    it('refuses an altitude given in two units, after the faults that come first', () => {
      expect(codeOf(() => Aprs.from('M0LTE').position(51, -1).altitudeFeet(10).altitudeM(3).build())).toBe('value-given-twice');
      expect(codeOf(() => Aprs.from('M0LTE').position(91, -1).altitudeFeet(10).altitudeM(3).build())).toBe('value-out-of-range');
    });

    it('calls too few telemetry values malformed', () => {
      expect(codeOf(info({ type: 'telemetry', sequence: '001', analog: [1, 2, 3, 4], bits: '00000000' }))).toBe('malformed');
    });

    it('names a builder refusal', () => {
      expect(codeOf(() => Aprs.from('M0LTE').message('N0CALL', 'x'.repeat(68)).build())).toBe('too-long');
    });
  });
});
