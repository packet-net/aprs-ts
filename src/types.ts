// The APRS data model: one interface per data type, joined in the discriminated union `AprsData`.
// Quantities keep the units APRS sends them in, with the unit in the name; nothing is converted.

import type { Diagnostic } from './diagnostics.js';

/** A display symbol: the table (`/`, `\`, or an overlay character) and the code. */
export interface AprsSymbol {
  /** `/` for the primary table, `\` for the alternate one, or an overlay `0`-`9` or `A`-`Z`. */
  readonly table: string;
  /** The symbol code, a printable ASCII character. */
  readonly code: string;
}

/**
 * A timestamp, as sent. `dhm-zulu` is `092345z`, `dhm-local` is `092345/`, `hms` is `234517h`,
 * `mdhm` (positionless weather) is `10090556`.
 */
export type AprsTimestamp =
  | { readonly kind: 'dhm-zulu'; readonly day: number; readonly hour: number; readonly minute: number }
  | { readonly kind: 'dhm-local'; readonly day: number; readonly hour: number; readonly minute: number }
  | { readonly kind: 'hms'; readonly hour: number; readonly minute: number; readonly second: number }
  | { readonly kind: 'mdhm'; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

/** GPS fix state in a compressed position's type byte. */
export type CompressionFix = 'old' | 'current';
/** NMEA source in a compressed position's type byte. */
export type CompressionSource = 'other' | 'gll' | 'gga' | 'rmc';
/** Compression origin in a compressed position's type byte. */
export type CompressionOrigin =
  | 'compressed'
  | 'tnc-beacon-text'
  | 'software'
  | 'reserved3'
  | 'kpc3'
  | 'pico'
  | 'other-tracker'
  | 'digipeater-conversion';

/** A compressed position's type byte (APRS12c ch. 9). */
export interface CompressionType {
  readonly fix: CompressionFix;
  readonly source: CompressionSource;
  readonly origin: CompressionOrigin;
}

/** Power, effective antenna height, gain and directivity codes, as sent (APRS12c ch. 7). */
export interface Phg {
  /** Power code 0-9: power in watts is the code squared. */
  readonly power: number;
  /** Height code, `0` and on through the ASCII table: height in feet is 10 x 2^code. */
  readonly height: number;
  /** Gain code 0-9, in dBi. */
  readonly gain: number;
  /** Directivity code 0-9: 0 is omni, 1-8 are 45-360 degrees. */
  readonly directivity: number;
  /** PHGR: beacons per hour (1-9, then A-Z for 10 and on). */
  readonly beaconsPerHour?: number;
}

/** Omni-DF signal strength, effective antenna height, gain and directivity codes (APRS12c ch. 7). */
export interface Dfs {
  readonly strength: number;
  readonly height: number;
  readonly gain: number;
  readonly directivity: number;
}

/** DF bearing and number/range/quality (APRS12c ch. 7). */
export interface DfBearing {
  readonly bearingDegrees: number;
  readonly number: number;
  readonly range: number;
  readonly quality: number;
}

/** An area object's shape (APRS12c ch. 11), codes 0-9. */
export type AreaShape =
  | 'open-circle'
  | 'line-down-right'
  | 'open-ellipse'
  | 'open-triangle'
  | 'open-box'
  | 'filled-circle'
  | 'line-down-left'
  | 'filled-ellipse'
  | 'filled-triangle'
  | 'filled-box';

/** An area object's colour: codes /0-/7 high intensity, then /8, /9, 10-15 low. */
export type AreaColor =
  | 'black'
  | 'blue'
  | 'green'
  | 'cyan'
  | 'red'
  | 'violet'
  | 'yellow'
  | 'gray'
  | 'black-low'
  | 'blue-low'
  | 'green-low'
  | 'cyan-low'
  | 'red-low'
  | 'violet-low'
  | 'yellow-low'
  | 'gray-low';

/** An area object (the `\l` symbol), offsets as sent (APRS12c ch. 11). */
export interface AreaObject {
  readonly shape: AreaShape;
  readonly color: AreaColor;
  /** yy: the square root of 1500 x the latitude offset in degrees. */
  readonly latOffset: number;
  /** xx: the square root of 1500 x the longitude offset in degrees. */
  readonly lonOffset: number;
  /** A line's corridor width either side, in miles, from `{...}` in the comment. */
  readonly corridorWidthMiles?: number;
}

/** Storm type (APRS12c ch. 12). */
export type StormType = 'tropical-storm' | 'hurricane' | 'tropical-depression';

/** Storm data (APRS12c ch. 12). */
export interface Storm {
  readonly type: StormType;
  readonly sustainedWindKnots?: number;
  readonly gustKnots?: number;
  readonly centralPressureMbar?: number;
  readonly hurricaneRadiusNm?: number;
  readonly tropicalStormRadiusNm?: number;
  readonly wholeGaleRadiusNm?: number;
}

/** How precise a `!DAO!` is. */
export type DaoPrecision = 'none' | 'thousandths' | 'base91';

/** The `!DAO!` datum and precision (APRS12c ch. 5). */
export interface Dao {
  /** The datum letter, upper case (`W` is WGS84). */
  readonly datum: string;
  readonly precision: DaoPrecision;
}

/** Base-91 comment telemetry (APRS12c ch. 13). */
export interface CommentTelemetry {
  readonly sequence: number;
  /** One to five analog values, 0-8280. */
  readonly analog: readonly number[];
  /** The eight digital bits as a number, B1 the least significant bit. */
  readonly digital?: number;
}

/** A voice frequency's tone type (APRS12c ch. 18). */
export type ToneType = 'off' | 'tone' | 'ctcss' | 'dcs' | 'tone-burst';

/** An APRS 1.2 voice frequency (APRS12c ch. 18). */
export interface VoiceFrequency {
  readonly mhz: number;
  readonly tone?: ToneType;
  /** Tone in Hz without the tenths, or the DCS code. Absent for `off` and `tone-burst`. */
  readonly toneValue?: number;
  /** Transmit offset in kHz. */
  readonly offsetKhz?: number;
  /** Nominal range, in miles unless `rangeKm`. */
  readonly range?: number;
  readonly rangeKm?: boolean;
  /** Narrow modulation (a lower-case tone letter). */
  readonly narrow?: boolean;
  /** Sent as `FFF.FF MHz`, to the nearest 10 kHz. */
  readonly tenKhzResolution?: boolean;
}

/** An extra weather field: a letter the spec does not define, and its value as sent. */
export interface ExtraWeatherField {
  readonly letter: string;
  readonly value: string;
}

/** Weather data (APRS12c ch. 12), in the units sent. */
export interface Weather {
  readonly windDirectionDegrees?: number;
  readonly windSpeedMph?: number;
  readonly windGustMph?: number;
  readonly temperatureF?: number;
  readonly rain1hIn?: number;
  readonly rain24hIn?: number;
  readonly rainMidnightIn?: number;
  /** The raw rain counter (`#`). */
  readonly rainRaw?: number;
  readonly humidityPercent?: number;
  readonly pressureMbar?: number;
  readonly luminosityWM2?: number;
  readonly snow24hIn?: number;
  /** The APRS software type letter. */
  readonly software?: string;
  /** The weather station unit type, 2-4 characters. */
  readonly unit?: string;
  readonly extra?: readonly ExtraWeatherField[];
}

/** The fields positions, Mic-E reports, objects and items share. */
export interface PositionedFields {
  /** Degrees, north positive, with any `!DAO!` applied; the centre of an ambiguous position. */
  readonly latitude: number;
  /** Degrees, east positive. */
  readonly longitude: number;
  /** How many digits were blanked, 1-4. */
  readonly ambiguity?: number;
  readonly symbol: AprsSymbol;
  readonly compressed?: boolean;
  readonly compression?: CompressionType;
  readonly courseDegrees?: number;
  readonly speedKnots?: number;
  readonly altitudeFeet?: number;
  readonly phg?: Phg;
  readonly rangeMiles?: number;
  readonly dfs?: Dfs;
  readonly area?: AreaObject;
  readonly dfBearing?: DfBearing;
  readonly storm?: Storm;
  readonly dao?: Dao;
  readonly telemetry?: CommentTelemetry;
  readonly frequency?: VoiceFrequency;
  readonly weather?: Weather;
  /** A signpost's 1-3 characters (the `\m` symbol). */
  readonly signpost?: string;
  /** The free text left once every structured element is lifted out. */
  readonly comment?: string;
}

/** A position report (`!`, `=`, `/`, `@`). */
export interface PositionReport extends PositionedFields {
  readonly type: 'position';
  readonly timestamp?: AprsTimestamp;
  /** The sender is messaging capable (`=` or `@`). */
  readonly messaging?: boolean;
}

/** A Mic-E message type (APRS12c ch. 10). */
export type MicEMessage =
  | 'off-duty'
  | 'en-route'
  | 'in-service'
  | 'returning'
  | 'committed'
  | 'special'
  | 'priority'
  | 'custom0'
  | 'custom1'
  | 'custom2'
  | 'custom3'
  | 'custom4'
  | 'custom5'
  | 'custom6'
  | 'emergency'
  | 'unknown';

/** A Mic-E report: position in the destination address and the information field. */
export interface MicEReport extends PositionedFields {
  readonly type: 'mic-e';
  readonly micEMessage: MicEMessage;
  /** `'` rather than `` ` ``: old GPS data. */
  readonly oldData?: boolean;
  /** The device type code before the status text: `` ` ``, `'`, `>`, `]` or a space. */
  readonly typeCode?: string;
  /** The device suffix at the end of the status text, when the device database knows it. */
  readonly deviceSuffix?: string;
  readonly locator?: string;
  /** Obsolete Mic-E telemetry values. */
  readonly legacyTelemetry?: readonly number[];
  /** The destination address SSID: the generic digipeater path code. */
  readonly destinationSsid?: number;
}

/** An object report (`;`). */
export interface ObjectReport extends PositionedFields {
  readonly type: 'object';
  readonly name: string;
  readonly killed?: boolean;
  readonly timestamp?: AprsTimestamp;
}

/** An item report (`)`). */
export interface ItemReport extends PositionedFields {
  readonly type: 'item';
  readonly name: string;
  readonly killed?: boolean;
}

/** A message (`:`). */
export interface Message {
  readonly type: 'message';
  readonly addressee: string;
  readonly text: string;
  readonly messageId?: string;
  /** A reply-ack; the empty string says the sender is reply-ack capable with nothing to ack. */
  readonly replyAck?: string;
}

/** A message acknowledgement. */
export interface Ack {
  readonly type: 'ack';
  readonly addressee: string;
  readonly ackedId: string;
  readonly replyAck?: string;
}

/** A message rejection. */
export interface Reject {
  readonly type: 'reject';
  readonly addressee: string;
  readonly rejectedId: string;
  readonly replyAck?: string;
}

/** A bulletin or announcement (addressee `BLN...`). */
export interface Bulletin {
  readonly type: 'bulletin';
  readonly addressee: string;
  readonly text: string;
  readonly messageId?: string;
}

/** A National Weather Service bulletin (addressee `NWS-...` and similar). */
export interface NwsBulletin {
  readonly type: 'nws-bulletin';
  readonly addressee: string;
  readonly text: string;
  readonly messageId?: string;
}

/** Telemetry channel names (`PARM.`). */
export interface TelemetryNames {
  readonly type: 'telemetry-names';
  readonly addressee: string;
  readonly names: readonly string[];
  readonly messageId?: string;
}

/** Telemetry units and labels (`UNIT.`). */
export interface TelemetryUnits {
  readonly type: 'telemetry-units';
  readonly addressee: string;
  readonly units: readonly string[];
  readonly messageId?: string;
}

/** Telemetry equation coefficients (`EQNS.`). */
export interface TelemetryCoefficients {
  readonly type: 'telemetry-coefficients';
  readonly addressee: string;
  readonly coefficients: readonly number[];
  /** The coefficients as sent (`.53`), so they can be written back the same. */
  readonly coefficientsText?: readonly string[];
  readonly messageId?: string;
}

/** Telemetry bit sense and project title (`BITS.`). */
export interface TelemetryBits {
  readonly type: 'telemetry-bits';
  readonly addressee: string;
  /** Eight `0`/`1` characters, B1 first. */
  readonly bits: string;
  readonly project?: string;
  readonly messageId?: string;
}

/** A directed query (`?APRSx` in a message). */
export interface DirectedQuery {
  readonly type: 'directed-query';
  readonly addressee: string;
  readonly queryType: string;
  readonly target?: string;
}

/** A status report (`>`). */
export interface StatusReport {
  readonly type: 'status';
  readonly timestamp?: AprsTimestamp;
  readonly locator?: string;
  readonly symbol?: AprsSymbol;
  /** Meteor scatter beam heading and power codes (`^B7`). */
  readonly beam?: { readonly headingCode: string; readonly powerCode: string };
  readonly text?: string;
}

/** A telemetry report (`T#`). */
export interface TelemetryReport {
  readonly type: 'telemetry';
  /** The sequence as sent. */
  readonly sequence: string;
  /** Analog values; `null` for an empty one. */
  readonly analog: readonly (number | null)[];
  /** The analog values as sent (`073`, `190.0`), so they can be written back the same. */
  readonly analogText?: readonly (string | null)[];
  /** Eight `0`/`1` characters, B1 first. */
  readonly bits?: string;
  readonly comment?: string;
}

/** A positionless weather report (`_`). */
export interface WeatherReport {
  readonly type: 'weather';
  readonly timestamp?: AprsTimestamp;
  readonly weather: Weather;
  readonly comment?: string;
}

/** Raw weather station data format. */
export type RawWeatherFormat = 'peet-bros-hash' | 'peet-bros-star' | 'ultimeter-packet' | 'ultimeter-logging';

/** Raw weather station data (`#`, `*`, `$ULTW`, `!!`), kept as text. */
export interface RawWeather {
  readonly type: 'raw-weather';
  readonly format: RawWeatherFormat;
  readonly data?: string;
}

/** A raw NMEA sentence (`$`). */
export interface NmeaSentence {
  readonly type: 'nmea';
  /** The sentence without the `$`. */
  readonly sentence: string;
  readonly hasChecksum?: boolean;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly fix?: 'valid' | 'invalid';
  readonly courseDegrees?: number;
  readonly speedKnots?: number;
  readonly altitudeM?: number;
  /** `HH:MM:SS`, with any fraction of a second. */
  readonly time?: string;
  readonly waypoint?: string;
}

/** A Maidenhead locator beacon (`[`), obsolete. */
export interface MaidenheadBeacon {
  readonly type: 'maidenhead-beacon';
  readonly locator: string;
  readonly comment?: string;
}

/** A general query (`?`). */
export interface Query {
  readonly type: 'query';
  readonly queryType: string;
  readonly footprint?: { readonly latitude: number; readonly longitude: number; readonly radiusMiles: number };
}

/** A station capability: a token, or a token and its value. */
export type Capability = readonly [token: string] | readonly [token: string, value: string];

/** Station capabilities (`<`). */
export interface Capabilities {
  readonly type: 'capabilities';
  readonly capabilities: readonly Capability[];
}

/** Third-party traffic (`}`): a packet from another network. */
export interface ThirdParty {
  readonly type: 'third-party';
  readonly packet: AprsPacket;
}

/** User-defined data (`{`). */
export interface UserDefined {
  readonly type: 'user-defined';
  readonly userId: string;
  readonly packetType: string;
  /** The data, one character per byte (U+0000-U+00FF). */
  readonly data?: string;
}

/** Invalid or test data (`,`). */
export interface TestData {
  readonly type: 'test';
  readonly data?: string;
}

/** An Agrelo DFJr / MicroFinder report (`%`). */
export interface AgreloDf {
  readonly type: 'agrelo-df';
  readonly bearingDegrees: number;
  readonly quality: number;
}

/** Why a packet's data was not decoded. */
export type UnrecognizedReason = 'empty' | 'not-aprs' | 'reserved-data-type' | 'malformed';

/** Data that was not decoded; the diagnostics say why. */
export interface Unrecognized {
  readonly type: 'unrecognized';
  readonly reason: UnrecognizedReason;
}

/** Every kind of APRS data. */
export type AprsData =
  | PositionReport
  | MicEReport
  | ObjectReport
  | ItemReport
  | Message
  | Ack
  | Reject
  | Bulletin
  | NwsBulletin
  | TelemetryNames
  | TelemetryUnits
  | TelemetryCoefficients
  | TelemetryBits
  | DirectedQuery
  | StatusReport
  | TelemetryReport
  | WeatherReport
  | RawWeather
  | NmeaSentence
  | MaidenheadBeacon
  | Query
  | Capabilities
  | ThirdParty
  | UserDefined
  | TestData
  | AgreloDf
  | Unrecognized;

/** The `type` of each kind of data. */
export type AprsDataType = AprsData['type'];

/** Data that has a position. */
export type PositionedData = PositionReport | MicEReport | ObjectReport | ItemReport;

/** A digipeater path entry. */
export interface PathEntry {
  /** The address, e.g. `WIDE2-1` or `qAR`. */
  readonly address: string;
  /** Marked used (`*`), or implied used by a later used entry. */
  readonly used: boolean;
}

/** An APRS-IS q-construct and the station it names (the IGate). */
export interface QConstruct {
  /** e.g. `qAR`. */
  readonly construct: string;
  readonly station?: string;
}

/** A device from the APRS device identification database. */
export interface DeviceInfo {
  readonly vendor?: string;
  readonly model?: string;
  readonly class?: string;
  readonly os?: string;
  /** e.g. `messaging`, `item-in-msg`. */
  readonly features?: readonly string[];
}

/** A decoded APRS packet. */
export interface AprsPacket {
  readonly source: string;
  readonly destination: string;
  readonly path: readonly PathEntry[];
  /** The information field as received (for AX.25, as in the frame). */
  readonly information: Uint8Array;
  readonly data: AprsData;
  /** Everything the decoder noticed, header first. */
  readonly diagnostics: readonly Diagnostic[];
  /** The APRS-IS q-construct in the path, if any. */
  readonly qConstruct?: QConstruct;
  /** The sending device, from the device identification database. */
  readonly device?: DeviceInfo;
}
