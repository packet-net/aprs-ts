// A fluent builder for the packets an application typically sends.
//
//   const packet = Aprs.from('M0LTE-9')
//     .via('WIDE1-1', 'WIDE2-1')
//     .position(51.45, -0.98)
//     .symbol(Symbols.car)
//     .course(88)
//     .speed(36)
//     .comment('Mobile')
//     .build();
//   packet.toTnc2(); // 'M0LTE-9>APZ001,WIDE1-1,WIDE2-1:!5127.00N/00058.80W>088/036Mobile'
//
// `build()` encodes the packet, so anything the spec does not allow is refused there, with an
// `AprsEncodeError` that says why.

import { encodeInformation, encodeAx25, encodeTnc2, encodeTnc2Bytes, wrapKiss, type PacketToEncode } from './encode/index.js';
import { symbolOf } from './symbols.js';
import type {
  AprsData,
  AprsSymbol,
  AprsTimestamp,
  CommentTelemetry,
  CompressionType,
  Dao,
  MicEMessage,
  Phg,
  PositionedFields,
  VoiceFrequency,
  Weather,
} from './types.js';

/** The tocall used when none is given: the experimental `APZ` range. */
export const DEFAULT_DESTINATION = 'APZ001';

/** A packet the builder made: its parts, and the ways to send it. */
export interface BuiltPacket {
  readonly source: string;
  /** The destination (for Mic-E, the one the encoder computed). */
  readonly destination: string;
  readonly path: readonly string[];
  readonly data: AprsData;
  /** The information field bytes. */
  readonly information: Uint8Array;
  /** The TNC2 / APRS-IS line. */
  toTnc2(): string;
  /** The TNC2 / APRS-IS line as bytes. */
  toTnc2Bytes(): Uint8Array;
  /** The AX.25 UI frame (no flags, no FCS). */
  toAx25(): Uint8Array;
  /** The AX.25 frame wrapped for a KISS TNC. */
  toKiss(port?: number): Uint8Array;
}

interface Header {
  source: string;
  destination?: string;
  path: string[];
}

function built(header: Header, data: AprsData): BuiltPacket {
  const encoded = encodeInformation(data);
  const destination = encoded.destination ?? header.destination ?? DEFAULT_DESTINATION;
  const toEncode: PacketToEncode = { source: header.source, destination, path: header.path, data };
  return Object.freeze({
    source: header.source,
    destination,
    path: Object.freeze([...header.path]),
    data,
    information: encoded.info,
    toTnc2: () => encodeTnc2(toEncode),
    toTnc2Bytes: () => encodeTnc2Bytes(toEncode),
    toAx25: () => encodeAx25(toEncode),
    toKiss: (port = 0) => wrapKiss(encodeAx25(toEncode), port),
  });
}

function asSymbol(symbol: AprsSymbol | string): AprsSymbol {
  return typeof symbol === 'string' ? symbolOf(symbol) : symbol;
}

/**
 * A timestamp from a `Date`, in UTC: day, hour and minute (`dhm-zulu`, the recommended form),
 * or hours, minutes and seconds (`hms`).
 */
export function timestampOf(date: Date, kind: 'dhm-zulu' | 'hms' = 'dhm-zulu'): AprsTimestamp {
  return kind === 'hms'
    ? { kind: 'hms', hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() }
    : { kind: 'dhm-zulu', day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
}

function asTimestamp(t: Date | AprsTimestamp, kind?: 'dhm-zulu' | 'hms'): AprsTimestamp {
  return t instanceof Date ? timestampOf(t, kind) : t;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Starts a packet: `Aprs.from('M0LTE-9')`. */
export const Aprs = {
  /** A packet from `source`. */
  from(source: string): PacketBuilder {
    return new PacketBuilder({ source, path: [] });
  },
};

/** The header, then the kind of packet. */
export class PacketBuilder {
  constructor(private readonly header: Header) {}

  /** The destination (tocall) identifying the sending software; ignored for Mic-E. */
  to(destination: string): PacketBuilder {
    return new PacketBuilder({ ...this.header, destination });
  }

  /** The digipeater path, e.g. `via('WIDE1-1', 'WIDE2-1')`. */
  via(...path: string[]): PacketBuilder {
    return new PacketBuilder({ ...this.header, path: [...this.header.path, ...path] });
  }

  /** A position report. */
  position(latitude: number, longitude: number): PositionBuilder {
    return new PositionBuilder(this.header, latitude, longitude);
  }

  /** A weather report at a position (the weather station symbol, unless you pick another `_`). */
  weather(latitude: number, longitude: number, weather: Weather): PositionBuilder {
    return new PositionBuilder(this.header, latitude, longitude).symbol('/_').weather(weather);
  }

  /** An object: `timestamp` defaults to now (objects always carry one). */
  object(name: string, latitude: number, longitude: number): ObjectBuilder {
    return new ObjectBuilder(this.header, name, latitude, longitude);
  }

  /** An item. */
  item(name: string, latitude: number, longitude: number): ItemBuilder {
    return new ItemBuilder(this.header, name, latitude, longitude);
  }

  /** A Mic-E report: its position and message type go in the destination address. */
  micE(latitude: number, longitude: number): MicEBuilder {
    return new MicEBuilder(this.header, latitude, longitude);
  }

  /** A message to `addressee`. */
  message(addressee: string, text: string): MessageBuilder {
    return new MessageBuilder(this.header, addressee, text);
  }

  /** An acknowledgement of message `id` from `addressee`. */
  ack(addressee: string, id: string): DataBuilder {
    return new DataBuilder(this.header, { type: 'ack', addressee, ackedId: id });
  }

  /** A rejection of message `id` from `addressee`. */
  reject(addressee: string, id: string): DataBuilder {
    return new DataBuilder(this.header, { type: 'reject', addressee, rejectedId: id });
  }

  /** A bulletin (`id` a digit) or announcement (`id` a letter), optionally to a group. */
  bulletin(id: string, text: string, group = ''): DataBuilder {
    return new DataBuilder(this.header, { type: 'bulletin', addressee: `BLN${id}${group}`, text });
  }

  /** A status report. */
  status(text?: string): StatusBuilder {
    return new StatusBuilder(this.header, text);
  }

  /** A telemetry report: sequence, five analog values and eight bits (`'01101001'`, B1 first). */
  telemetry(sequence: number | string, analog: readonly (number | null)[], bits: string): TelemetryBuilder {
    const seq = typeof sequence === 'number' ? String(sequence).padStart(3, '0') : sequence;
    return new TelemetryBuilder(this.header, seq, analog, bits);
  }

  /** Telemetry channel names (`PARM.`), sent to the station whose telemetry they describe. */
  telemetryNames(addressee: string, names: readonly string[]): DataBuilder {
    return new DataBuilder(this.header, { type: 'telemetry-names', addressee, names: [...names] });
  }

  /** Telemetry units and labels (`UNIT.`). */
  telemetryUnits(addressee: string, units: readonly string[]): DataBuilder {
    return new DataBuilder(this.header, { type: 'telemetry-units', addressee, units: [...units] });
  }

  /** Telemetry equation coefficients (`EQNS.`): a, b, c for each analog channel. */
  telemetryCoefficients(addressee: string, coefficients: readonly number[]): DataBuilder {
    return new DataBuilder(this.header, { type: 'telemetry-coefficients', addressee, coefficients: [...coefficients] });
  }

  /** Telemetry bit sense and project title (`BITS.`). */
  telemetryBits(addressee: string, bits: string, project?: string): DataBuilder {
    const data: Mutable<Extract<AprsData, { type: 'telemetry-bits' }>> = { type: 'telemetry-bits', addressee, bits };
    if (project !== undefined) data.project = project;
    return new DataBuilder(this.header, data);
  }

  /** A positionless weather report (not recommended: a weather report with a position is better). */
  weatherReport(weather: Weather, at: Date = new Date()): DataBuilder {
    const timestamp: AprsTimestamp = {
      kind: 'mdhm',
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
    };
    return new DataBuilder(this.header, { type: 'weather', timestamp, weather });
  }

  /** Any data, built by hand. */
  data(data: AprsData): DataBuilder {
    return new DataBuilder(this.header, data);
  }
}

/** Builds data that needs nothing more. */
export class DataBuilder {
  constructor(
    protected readonly header: Header,
    protected readonly value: AprsData,
  ) {}

  /** Encodes the packet; throws `AprsEncodeError` if the spec does not allow it. */
  build(): BuiltPacket {
    return built(this.header, this.value);
  }

  /** Shorthand for `build().toTnc2()`. */
  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** What positions, objects, items and Mic-E reports share. */
abstract class PositionedBuilder<Self> {
  protected fields: Mutable<PositionedFields>;

  constructor(
    protected readonly header: Header,
    latitude: number,
    longitude: number,
  ) {
    this.fields = { latitude, longitude, symbol: { table: '/', code: '/' } };
  }

  protected abstract self(): Self;

  /** The display symbol: `Symbols.car`, or its two characters (`'/>'`). */
  symbol(symbol: AprsSymbol | string): Self {
    this.fields.symbol = asSymbol(symbol);
    return this.self();
  }

  /** Course over the ground, degrees 1-360 (360 is north). */
  course(degrees: number): Self {
    this.fields.courseDegrees = degrees;
    return this.self();
  }

  /** Speed, knots. */
  speed(knots: number): Self {
    this.fields.speedKnots = knots;
    return this.self();
  }

  /** Altitude, feet. */
  altitude(feet: number): Self {
    this.fields.altitudeFeet = feet;
    return this.self();
  }

  /** Altitude, metres (sent in feet, rounded). */
  altitudeMetres(metres: number): Self {
    this.fields.altitudeFeet = Math.round(metres / 0.3048);
    return this.self();
  }

  /** Free text. */
  comment(text: string): Self {
    this.fields.comment = text;
    return this.self();
  }

  /** An APRS 1.2 voice frequency, e.g. `frequency(145.5, { tone: 'tone', toneValue: 77 })`. */
  frequency(mhz: number, details: Omit<VoiceFrequency, 'mhz'> = {}): Self {
    this.fields.frequency = { mhz, ...details };
    return this.self();
  }

  /** Base-91 comment telemetry: a sequence and one to five analog values (0-8280). */
  commentTelemetry(sequence: number, analog: readonly number[], digital?: number): Self {
    const t: Mutable<CommentTelemetry> = { sequence, analog: [...analog] };
    if (digital !== undefined) t.digital = digital;
    this.fields.telemetry = t;
    return this.self();
  }

  /** A `!DAO!` for about a foot of precision (base-91), with its datum (`W` is WGS84). */
  dao(datum = 'W', precision: Dao['precision'] = 'base91'): Self {
    this.fields.dao = { datum, precision };
    return this.self();
  }

  /** Blanks 1-4 digits of the position (APRS12c ch. 6). */
  ambiguity(digits: number): Self {
    this.fields.ambiguity = digits;
    return this.self();
  }
}

/** A position (`!`, `=`, `/`, `@`), or an object or item's position. */
abstract class ReportBuilder<Self> extends PositionedBuilder<Self> {
  /** Power, antenna height, gain and directivity codes (APRS12c ch. 7). */
  phg(power: number, height: number, gain: number, directivity = 0, beaconsPerHour?: number): Self {
    const phg: Mutable<Phg> = { power, height, gain, directivity };
    if (beaconsPerHour !== undefined) phg.beaconsPerHour = beaconsPerHour;
    this.fields.phg = phg;
    return this.self();
  }

  /** A pre-calculated radio range, miles. */
  range(miles: number): Self {
    this.fields.rangeMiles = miles;
    return this.self();
  }

  /** Weather data (needs a weather station symbol, `_`). */
  weather(weather: Weather): Self {
    this.fields.weather = weather;
    return this.self();
  }

  /** The compressed format (APRS12c ch. 9), with its type byte if you want to set it. */
  compressed(compression?: CompressionType): Self {
    this.fields.compressed = true;
    if (compression) this.fields.compression = compression;
    return this.self();
  }
}

/** A position report. */
export class PositionBuilder extends ReportBuilder<PositionBuilder> {
  private timestampValue?: AprsTimestamp;
  private messagingValue = false;

  protected self(): PositionBuilder {
    return this;
  }

  /** When the position was fixed: a `Date` (UTC) or a timestamp. */
  timestamp(at: Date | AprsTimestamp, kind?: 'dhm-zulu' | 'hms'): PositionBuilder {
    this.timestampValue = asTimestamp(at, kind);
    return this;
  }

  /** The sender can receive APRS messages. */
  messaging(capable = true): PositionBuilder {
    this.messagingValue = capable;
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'position' }>> = { type: 'position', ...this.fields };
    if (this.timestampValue) data.timestamp = this.timestampValue;
    if (this.messagingValue) data.messaging = true;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** An object report. */
export class ObjectBuilder extends ReportBuilder<ObjectBuilder> {
  private timestampValue: AprsTimestamp = timestampOf(new Date());
  private killedValue = false;

  constructor(
    header: Header,
    private readonly name: string,
    latitude: number,
    longitude: number,
  ) {
    super(header, latitude, longitude);
  }

  protected self(): ObjectBuilder {
    return this;
  }

  /** When the object was at this position (defaults to now). */
  timestamp(at: Date | AprsTimestamp, kind?: 'dhm-zulu' | 'hms'): ObjectBuilder {
    this.timestampValue = asTimestamp(at, kind);
    return this;
  }

  /** Kills the object: receivers remove it. */
  killed(killed = true): ObjectBuilder {
    this.killedValue = killed;
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'object' }>> = {
      type: 'object',
      name: this.name,
      timestamp: this.timestampValue,
      ...this.fields,
    };
    if (this.killedValue) data.killed = true;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** An item report. */
export class ItemBuilder extends ReportBuilder<ItemBuilder> {
  private killedValue = false;

  constructor(
    header: Header,
    private readonly name: string,
    latitude: number,
    longitude: number,
  ) {
    super(header, latitude, longitude);
  }

  protected self(): ItemBuilder {
    return this;
  }

  /** Kills the item: receivers remove it. */
  killed(killed = true): ItemBuilder {
    this.killedValue = killed;
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'item' }>> = { type: 'item', name: this.name, ...this.fields };
    if (this.killedValue) data.killed = true;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** A Mic-E report. */
export class MicEBuilder extends PositionedBuilder<MicEBuilder> {
  private messageValue: MicEMessage = 'off-duty';
  private typeCodeValue: string | undefined = '`';
  private locatorValue?: string;
  private oldValue = false;

  protected self(): MicEBuilder {
    return this;
  }

  /** The Mic-E message: `off-duty` (the default), `en-route`, `in-service`, `returning`, ... */
  micEMessage(message: MicEMessage): MicEBuilder {
    this.messageValue = message;
    return this;
  }

  /** Whether the sender can receive messages: the `` ` `` (yes, the default) or `'` type code. */
  messaging(capable = true): MicEBuilder {
    this.typeCodeValue = capable ? '`' : "'";
    return this;
  }

  /** A Maidenhead locator in the status text. */
  locator(locator: string): MicEBuilder {
    this.locatorValue = locator.toUpperCase();
    return this;
  }

  /** Marks the position as old (not current) GPS data. */
  old(old = true): MicEBuilder {
    this.oldValue = old;
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'mic-e' }>> = { type: 'mic-e', micEMessage: this.messageValue, ...this.fields };
    if (this.typeCodeValue !== undefined) data.typeCode = this.typeCodeValue;
    if (this.locatorValue !== undefined) data.locator = this.locatorValue;
    if (this.oldValue) data.oldData = true;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** A message. */
export class MessageBuilder {
  private idValue?: string;
  private replyAckValue?: string;

  constructor(
    private readonly header: Header,
    private readonly addressee: string,
    private readonly text: string,
  ) {}

  /** A message ID (1-5 letters or digits), so the addressee acknowledges it. */
  id(id: string | number): MessageBuilder {
    this.idValue = String(id);
    return this;
  }

  /** A reply-ack: the ID of the other station's message this also acknowledges; `''` for none. */
  replyAck(id = ''): MessageBuilder {
    this.replyAckValue = id;
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'message' }>> = {
      type: 'message',
      addressee: this.addressee,
      text: this.text,
    };
    if (this.idValue !== undefined) data.messageId = this.idValue;
    if (this.replyAckValue !== undefined) data.replyAck = this.replyAckValue;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** A status report. */
export class StatusBuilder {
  private timestampValue?: AprsTimestamp;
  private locatorValue?: { locator: string; symbol: AprsSymbol };
  private beamValue?: { headingCode: string; powerCode: string };

  constructor(
    private readonly header: Header,
    private readonly text?: string,
  ) {}

  /** When (UTC day, hour and minute). A status with a locator has no timestamp. */
  timestamp(at: Date | AprsTimestamp): StatusBuilder {
    this.timestampValue = asTimestamp(at, 'dhm-zulu');
    return this;
  }

  /** A Maidenhead locator and a symbol, in place of a timestamp. */
  locator(locator: string, symbol: AprsSymbol | string): StatusBuilder {
    this.locatorValue = { locator: locator.toUpperCase(), symbol: asSymbol(symbol) };
    return this;
  }

  /** Meteor scatter beam heading and power codes (`^B7`). */
  beam(headingCode: string, powerCode: string): StatusBuilder {
    this.beamValue = { headingCode, powerCode };
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'status' }>> = { type: 'status' };
    if (this.timestampValue) data.timestamp = this.timestampValue;
    if (this.locatorValue) {
      data.locator = this.locatorValue.locator;
      data.symbol = this.locatorValue.symbol;
    }
    if (this.beamValue) data.beam = this.beamValue;
    if (this.text !== undefined && this.text.length > 0) data.text = this.text;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}

/** A telemetry report. */
export class TelemetryBuilder {
  private commentValue?: string;

  constructor(
    private readonly header: Header,
    private readonly sequence: string,
    private readonly analog: readonly (number | null)[],
    private readonly bits: string,
  ) {}

  /** Free text after the bits. */
  comment(text: string): TelemetryBuilder {
    this.commentValue = text;
    return this;
  }

  build(): BuiltPacket {
    const data: Mutable<Extract<AprsData, { type: 'telemetry' }>> = {
      type: 'telemetry',
      sequence: this.sequence,
      analog: [...this.analog],
      bits: this.bits,
    };
    if (this.commentValue !== undefined && this.commentValue.length > 0) data.comment = this.commentValue;
    return built(this.header, data);
  }

  toTnc2(): string {
    return this.build().toTnc2();
  }
}
