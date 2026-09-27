// The conformance vectors' language-neutral form (https://github.com/packet-net/aprs-vectors):
// snake_case names, empty values left out, booleans only when true, timestamps and symbols as
// sent. Used by the conformance tests and the differential dump, and handy for comparing this
// library with another implementation.

import type { DiagnosticCode } from './codes.js';
import { diagnostic, formatDiagnostic, type Diagnostic, type Severity } from './diagnostics.js';
import type {
  AprsData,
  AprsPacket,
  AprsSymbol,
  AprsTimestamp,
  AreaObject,
  CommentTelemetry,
  CompressionType,
  Dao,
  DfBearing,
  Dfs,
  PathEntry,
  Phg,
  PositionedFields,
  Storm,
  VoiceFrequency,
  Weather,
} from './types.js';

/** A JSON object. */
export type Neutral = { [key: string]: unknown };

function put(o: Neutral, key: string, value: unknown): void {
  if (value === undefined || value === null || value === false || value === '') return;
  if (Array.isArray(value) && value.length === 0) return;
  o[key] = value;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A timestamp as sent: `092345z`, `092345/`, `234517h` or `10090556`. */
export function formatTimestamp(t: AprsTimestamp): string {
  switch (t.kind) {
    case 'dhm-zulu':
      return `${pad2(t.day)}${pad2(t.hour)}${pad2(t.minute)}z`;
    case 'dhm-local':
      return `${pad2(t.day)}${pad2(t.hour)}${pad2(t.minute)}/`;
    case 'hms':
      return `${pad2(t.hour)}${pad2(t.minute)}${pad2(t.second)}h`;
    case 'mdhm':
      return `${pad2(t.month)}${pad2(t.day)}${pad2(t.hour)}${pad2(t.minute)}`;
  }
}

/** Parses a timestamp as sent; `undefined` if it is not one. */
export function parseTimestamp(text: string): AprsTimestamp | undefined {
  let m = /^([0-9]{2})([0-9]{2})([0-9]{2})([z/h])$/.exec(text);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4] === 'z') return { kind: 'dhm-zulu', day: a, hour: b, minute: c };
    if (m[4] === '/') return { kind: 'dhm-local', day: a, hour: b, minute: c };
    return { kind: 'hms', hour: a, minute: b, second: c };
  }
  m = /^([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$/.exec(text);
  if (m) return { kind: 'mdhm', month: Number(m[1]), day: Number(m[2]), hour: Number(m[3]), minute: Number(m[4]) };
  return undefined;
}

const sym = (s: AprsSymbol): string => s.table + s.code;

function compressionN(c: CompressionType): Neutral {
  return { fix: c.fix, source: c.source, origin: c.origin };
}

function phgN(p: Phg): Neutral {
  const o: Neutral = { power: p.power, height: p.height, gain: p.gain, directivity: p.directivity };
  put(o, 'beacons_per_hour', p.beaconsPerHour);
  return o;
}

function dfsN(d: Dfs): Neutral {
  return { strength: d.strength, height: d.height, gain: d.gain, directivity: d.directivity };
}

function areaN(a: AreaObject): Neutral {
  const o: Neutral = { shape: a.shape, color: a.color, lat_offset: a.latOffset, lon_offset: a.lonOffset };
  put(o, 'corridor_width_miles', a.corridorWidthMiles);
  return o;
}

function dfBearingN(d: DfBearing): Neutral {
  return { bearing_degrees: d.bearingDegrees, number: d.number, range: d.range, quality: d.quality };
}

function stormN(s: Storm): Neutral {
  const o: Neutral = { type: s.type };
  put(o, 'sustained_wind_knots', s.sustainedWindKnots);
  put(o, 'gust_knots', s.gustKnots);
  put(o, 'central_pressure_mbar', s.centralPressureMbar);
  put(o, 'hurricane_radius_nm', s.hurricaneRadiusNm);
  put(o, 'tropical_storm_radius_nm', s.tropicalStormRadiusNm);
  put(o, 'whole_gale_radius_nm', s.wholeGaleRadiusNm);
  return o;
}

function daoN(d: Dao): Neutral {
  return { datum: d.datum, precision: d.precision };
}

function telemetryN(t: CommentTelemetry): Neutral {
  const o: Neutral = { sequence: t.sequence, analog: [...t.analog] };
  put(o, 'digital', t.digital);
  return o;
}

function frequencyN(f: VoiceFrequency): Neutral {
  const o: Neutral = { mhz: f.mhz };
  put(o, 'tone', f.tone);
  put(o, 'tone_value', f.toneValue);
  put(o, 'offset_khz', f.offsetKhz);
  put(o, 'range', f.range);
  put(o, 'range_km', f.rangeKm);
  put(o, 'narrow', f.narrow);
  put(o, 'ten_khz_resolution', f.tenKhzResolution);
  return o;
}

function weatherN(w: Weather): Neutral {
  const o: Neutral = {};
  put(o, 'wind_direction_degrees', w.windDirectionDegrees);
  put(o, 'wind_speed_mph', w.windSpeedMph);
  put(o, 'wind_gust_mph', w.windGustMph);
  put(o, 'temperature_f', w.temperatureF);
  put(o, 'rain_1h_in', w.rain1hIn);
  put(o, 'rain_24h_in', w.rain24hIn);
  put(o, 'rain_midnight_in', w.rainMidnightIn);
  put(o, 'rain_raw', w.rainRaw);
  put(o, 'humidity_percent', w.humidityPercent);
  put(o, 'pressure_mbar', w.pressureMbar);
  put(o, 'luminosity_w_m2', w.luminosityWM2);
  put(o, 'snow_24h_in', w.snow24hIn);
  put(o, 'software', w.software);
  put(o, 'unit', w.unit);
  if (w.extra && w.extra.length > 0) o.extra = w.extra.map((e) => ({ letter: e.letter, value: e.value }));
  return o;
}

function positionedN(o: Neutral, d: PositionedFields): void {
  o.latitude = d.latitude;
  o.longitude = d.longitude;
  put(o, 'ambiguity', d.ambiguity);
  o.symbol = sym(d.symbol);
  put(o, 'compressed', d.compressed);
  if (d.compression) o.compression = compressionN(d.compression);
  put(o, 'course_degrees', d.courseDegrees);
  put(o, 'speed_knots', d.speedKnots);
  put(o, 'altitude_feet', d.altitudeFeet);
  if (d.phg) o.phg = phgN(d.phg);
  put(o, 'range_miles', d.rangeMiles);
  if (d.dfs) o.dfs = dfsN(d.dfs);
  if (d.area) o.area = areaN(d.area);
  if (d.dfBearing) o.df_bearing = dfBearingN(d.dfBearing);
  if (d.storm) o.storm = stormN(d.storm);
  if (d.dao) o.dao = daoN(d.dao);
  if (d.telemetry) o.telemetry = telemetryN(d.telemetry);
  if (d.frequency) o.frequency = frequencyN(d.frequency);
  if (d.weather) o.weather = weatherN(d.weather);
  put(o, 'signpost', d.signpost);
  put(o, 'comment', d.comment);
}

/** Formats a path entry as the neutral form writes it: `WIDE1-1`, or `N2GH*` when used. */
export function pathEntryN(e: PathEntry): string {
  return e.used ? `${e.address}*` : e.address;
}

/** A packet's data in the neutral form. */
export function toNeutralData(d: AprsData): Neutral {
  const o: Neutral = { type: d.type };
  switch (d.type) {
    case 'position':
      if (d.timestamp) o.timestamp = formatTimestamp(d.timestamp);
      put(o, 'messaging', d.messaging);
      positionedN(o, d);
      break;
    case 'mic-e':
      o.mic_e_message = d.micEMessage;
      put(o, 'old_data', d.oldData);
      put(o, 'type_code', d.typeCode);
      put(o, 'device_suffix', d.deviceSuffix);
      put(o, 'locator', d.locator);
      if (d.legacyTelemetry && d.legacyTelemetry.length > 0) o.legacy_telemetry = [...d.legacyTelemetry];
      put(o, 'destination_ssid', d.destinationSsid);
      positionedN(o, d);
      break;
    case 'object':
      o.name = d.name;
      put(o, 'killed', d.killed);
      if (d.timestamp) o.timestamp = formatTimestamp(d.timestamp);
      positionedN(o, d);
      break;
    case 'item':
      o.name = d.name;
      put(o, 'killed', d.killed);
      positionedN(o, d);
      break;
    case 'message':
      put(o, 'addressee', d.addressee);
      put(o, 'text', d.text);
      put(o, 'message_id', d.messageId);
      if (d.replyAck !== undefined) o.reply_ack = d.replyAck;
      break;
    case 'ack':
      put(o, 'addressee', d.addressee);
      put(o, 'acked_id', d.ackedId);
      if (d.replyAck !== undefined) o.reply_ack = d.replyAck;
      break;
    case 'reject':
      put(o, 'addressee', d.addressee);
      put(o, 'rejected_id', d.rejectedId);
      if (d.replyAck !== undefined) o.reply_ack = d.replyAck;
      break;
    case 'bulletin':
    case 'nws-bulletin':
      put(o, 'addressee', d.addressee);
      put(o, 'text', d.text);
      put(o, 'message_id', d.messageId);
      break;
    case 'telemetry-names':
      put(o, 'addressee', d.addressee);
      put(o, 'names', [...d.names]);
      put(o, 'message_id', d.messageId);
      break;
    case 'telemetry-units':
      put(o, 'addressee', d.addressee);
      put(o, 'units', [...d.units]);
      put(o, 'message_id', d.messageId);
      break;
    case 'telemetry-coefficients':
      put(o, 'addressee', d.addressee);
      put(o, 'coefficients', [...d.coefficients]);
      put(o, 'message_id', d.messageId);
      break;
    case 'telemetry-bits':
      put(o, 'addressee', d.addressee);
      put(o, 'bits', d.bits);
      put(o, 'project', d.project);
      put(o, 'message_id', d.messageId);
      break;
    case 'directed-query':
      put(o, 'addressee', d.addressee);
      put(o, 'query_type', d.queryType);
      put(o, 'target', d.target);
      break;
    case 'status':
      if (d.timestamp) o.timestamp = formatTimestamp(d.timestamp);
      put(o, 'locator', d.locator);
      if (d.symbol) o.symbol = sym(d.symbol);
      if (d.beam) o.beam = { heading_code: d.beam.headingCode, power_code: d.beam.powerCode };
      put(o, 'text', d.text);
      break;
    case 'telemetry':
      put(o, 'sequence', d.sequence);
      if (d.analog.length > 0) o.analog = [...d.analog];
      put(o, 'bits', d.bits);
      put(o, 'comment', d.comment);
      break;
    case 'weather':
      if (d.timestamp) o.timestamp = formatTimestamp(d.timestamp);
      o.weather = weatherN(d.weather);
      put(o, 'comment', d.comment);
      break;
    case 'raw-weather':
      o.format = d.format;
      put(o, 'data', d.data);
      break;
    case 'nmea':
      put(o, 'sentence', d.sentence);
      put(o, 'has_checksum', d.hasChecksum);
      put(o, 'latitude', d.latitude);
      put(o, 'longitude', d.longitude);
      put(o, 'fix', d.fix);
      put(o, 'course_degrees', d.courseDegrees);
      put(o, 'speed_knots', d.speedKnots);
      put(o, 'altitude_m', d.altitudeM);
      put(o, 'time', d.time);
      put(o, 'waypoint', d.waypoint);
      put(o, 'comment', d.comment);
      break;
    case 'maidenhead-beacon':
      put(o, 'locator', d.locator);
      put(o, 'comment', d.comment);
      break;
    case 'query':
      put(o, 'query_type', d.queryType);
      if (d.footprint)
        o.footprint = {
          latitude: d.footprint.latitude,
          longitude: d.footprint.longitude,
          radius_miles: d.footprint.radiusMiles,
        };
      break;
    case 'capabilities':
      if (d.capabilities.length > 0) o.capabilities = d.capabilities.map((c) => [...c]);
      break;
    case 'third-party':
      o.packet = toNeutralInner(d.packet);
      break;
    case 'user-defined':
      o.user_id = d.userId;
      o.packet_type = d.packetType;
      put(o, 'data', d.data);
      break;
    case 'test':
      put(o, 'data', d.data);
      break;
    case 'agrelo-df':
      o.bearing_degrees = d.bearingDegrees;
      o.quality = d.quality;
      break;
    case 'unrecognized':
      o.reason = d.reason;
      break;
  }
  return o;
}

function toNeutralInner(p: AprsPacket): Neutral {
  const o: Neutral = { source: p.source, destination: p.destination };
  put(o, 'path', p.path.map(pathEntryN));
  o.data = toNeutralData(p.data);
  put(o, 'diagnostics', p.diagnostics.map(formatDiagnostic));
  return o;
}

/** A packet's header in the neutral form. */
export function toNeutralHeader(p: AprsPacket): Neutral {
  const o: Neutral = { source: p.source, destination: p.destination };
  put(o, 'path', p.path.map(pathEntryN));
  if (p.qConstruct) {
    const q: Neutral = { construct: p.qConstruct.construct };
    put(q, 'station', p.qConstruct.station);
    o.q_construct = q;
  }
  return o;
}

/** A packet in the neutral form: `{header, data, diagnostics}`. */
export function toNeutralPacket(p: AprsPacket): Neutral {
  const o: Neutral = { header: toNeutralHeader(p), data: toNeutralData(p.data) };
  put(o, 'diagnostics', p.diagnostics.map(formatDiagnostic));
  return o;
}

// ---- from the neutral form (for encode cases)

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function symbolFrom(text: unknown): AprsSymbol {
  const t = String(text);
  return { table: t.slice(0, 1), code: t.slice(1) };
}

function timestampFrom(text: unknown): AprsTimestamp {
  const t = parseTimestamp(String(text));
  if (!t) throw new RangeError(`not a timestamp: ${String(text)}`);
  return t;
}

function opt<T>(o: Record<string, unknown>, key: string, value: T | undefined): void {
  if (value !== undefined) o[key] = value;
}

function weatherFrom(w: J): Weather {
  const o: Record<string, unknown> = {};
  opt(o, 'windDirectionDegrees', w.wind_direction_degrees);
  opt(o, 'windSpeedMph', w.wind_speed_mph);
  opt(o, 'windGustMph', w.wind_gust_mph);
  opt(o, 'temperatureF', w.temperature_f);
  opt(o, 'rain1hIn', w.rain_1h_in);
  opt(o, 'rain24hIn', w.rain_24h_in);
  opt(o, 'rainMidnightIn', w.rain_midnight_in);
  opt(o, 'rainRaw', w.rain_raw);
  opt(o, 'humidityPercent', w.humidity_percent);
  opt(o, 'pressureMbar', w.pressure_mbar);
  opt(o, 'luminosityWM2', w.luminosity_w_m2);
  opt(o, 'snow24hIn', w.snow_24h_in);
  opt(o, 'software', w.software);
  opt(o, 'unit', w.unit);
  if (Array.isArray(w.extra)) o.extra = w.extra.map((e: J) => ({ letter: e.letter, value: e.value }));
  return o as Weather;
}

function positionedFrom(o: Record<string, unknown>, d: J): void {
  o.latitude = d.latitude;
  o.longitude = d.longitude;
  opt(o, 'ambiguity', d.ambiguity);
  o.symbol = symbolFrom(d.symbol);
  if (d.compressed) o.compressed = true;
  if (d.compression) o.compression = { fix: d.compression.fix, source: d.compression.source, origin: d.compression.origin };
  opt(o, 'courseDegrees', d.course_degrees);
  opt(o, 'speedKnots', d.speed_knots);
  opt(o, 'altitudeFeet', d.altitude_feet);
  if (d.phg) {
    const p: Record<string, unknown> = { power: d.phg.power, height: d.phg.height, gain: d.phg.gain, directivity: d.phg.directivity };
    opt(p, 'beaconsPerHour', d.phg.beacons_per_hour);
    o.phg = p;
  }
  opt(o, 'rangeMiles', d.range_miles);
  if (d.dfs) o.dfs = { strength: d.dfs.strength, height: d.dfs.height, gain: d.dfs.gain, directivity: d.dfs.directivity };
  if (d.area) {
    const a: Record<string, unknown> = { shape: d.area.shape, color: d.area.color, latOffset: d.area.lat_offset, lonOffset: d.area.lon_offset };
    opt(a, 'corridorWidthMiles', d.area.corridor_width_miles);
    o.area = a;
  }
  if (d.df_bearing)
    o.dfBearing = {
      bearingDegrees: d.df_bearing.bearing_degrees,
      number: d.df_bearing.number,
      range: d.df_bearing.range,
      quality: d.df_bearing.quality,
    };
  if (d.storm) {
    const s: Record<string, unknown> = { type: d.storm.type };
    opt(s, 'sustainedWindKnots', d.storm.sustained_wind_knots);
    opt(s, 'gustKnots', d.storm.gust_knots);
    opt(s, 'centralPressureMbar', d.storm.central_pressure_mbar);
    opt(s, 'hurricaneRadiusNm', d.storm.hurricane_radius_nm);
    opt(s, 'tropicalStormRadiusNm', d.storm.tropical_storm_radius_nm);
    opt(s, 'wholeGaleRadiusNm', d.storm.whole_gale_radius_nm);
    o.storm = s;
  }
  if (d.dao) o.dao = { datum: d.dao.datum, precision: d.dao.precision };
  if (d.telemetry) {
    const t: Record<string, unknown> = { sequence: d.telemetry.sequence, analog: [...d.telemetry.analog] };
    opt(t, 'digital', d.telemetry.digital);
    o.telemetry = t;
  }
  if (d.frequency) {
    const f: Record<string, unknown> = { mhz: d.frequency.mhz };
    opt(f, 'tone', d.frequency.tone);
    opt(f, 'toneValue', d.frequency.tone_value);
    opt(f, 'offsetKhz', d.frequency.offset_khz);
    opt(f, 'range', d.frequency.range);
    if (d.frequency.range_km) f.rangeKm = true;
    if (d.frequency.narrow) f.narrow = true;
    if (d.frequency.ten_khz_resolution) f.tenKhzResolution = true;
    o.frequency = f;
  }
  if (d.weather) o.weather = weatherFrom(d.weather);
  opt(o, 'signpost', d.signpost);
  opt(o, 'comment', d.comment);
}

/** Data from the neutral form. */
export function fromNeutralData(d: J): AprsData {
  const o: Record<string, unknown> = { type: d.type };
  switch (d.type as AprsData['type']) {
    case 'position':
      if (d.timestamp !== undefined) o.timestamp = timestampFrom(d.timestamp);
      if (d.messaging) o.messaging = true;
      positionedFrom(o, d);
      break;
    case 'mic-e':
      o.micEMessage = d.mic_e_message;
      if (d.old_data) o.oldData = true;
      opt(o, 'typeCode', d.type_code);
      opt(o, 'deviceSuffix', d.device_suffix);
      opt(o, 'locator', d.locator);
      opt(o, 'legacyTelemetry', d.legacy_telemetry);
      opt(o, 'destinationSsid', d.destination_ssid);
      positionedFrom(o, d);
      break;
    case 'object':
      o.name = d.name;
      if (d.killed) o.killed = true;
      if (d.timestamp !== undefined) o.timestamp = timestampFrom(d.timestamp);
      positionedFrom(o, d);
      break;
    case 'item':
      o.name = d.name;
      if (d.killed) o.killed = true;
      positionedFrom(o, d);
      break;
    case 'message':
      o.addressee = d.addressee ?? '';
      o.text = d.text ?? '';
      opt(o, 'messageId', d.message_id);
      opt(o, 'replyAck', d.reply_ack);
      break;
    case 'ack':
      o.addressee = d.addressee ?? '';
      o.ackedId = d.acked_id ?? '';
      opt(o, 'replyAck', d.reply_ack);
      opt(o, 'messageId', d.message_id);
      break;
    case 'reject':
      o.addressee = d.addressee ?? '';
      o.rejectedId = d.rejected_id ?? '';
      opt(o, 'replyAck', d.reply_ack);
      opt(o, 'messageId', d.message_id);
      break;
    case 'bulletin':
    case 'nws-bulletin':
      o.addressee = d.addressee ?? '';
      o.text = d.text ?? '';
      opt(o, 'messageId', d.message_id);
      break;
    case 'telemetry-names':
      o.addressee = d.addressee ?? '';
      o.names = d.names ?? [];
      opt(o, 'messageId', d.message_id);
      break;
    case 'telemetry-units':
      o.addressee = d.addressee ?? '';
      o.units = d.units ?? [];
      opt(o, 'messageId', d.message_id);
      break;
    case 'telemetry-coefficients':
      o.addressee = d.addressee ?? '';
      o.coefficients = d.coefficients ?? [];
      opt(o, 'messageId', d.message_id);
      break;
    case 'telemetry-bits':
      o.addressee = d.addressee ?? '';
      o.bits = d.bits ?? '';
      opt(o, 'project', d.project);
      opt(o, 'messageId', d.message_id);
      break;
    case 'directed-query':
      o.addressee = d.addressee ?? '';
      o.queryType = d.query_type ?? '';
      opt(o, 'target', d.target);
      break;
    case 'status':
      if (d.timestamp !== undefined) o.timestamp = timestampFrom(d.timestamp);
      opt(o, 'locator', d.locator);
      if (d.symbol !== undefined) o.symbol = symbolFrom(d.symbol);
      if (d.beam) o.beam = { headingCode: d.beam.heading_code, powerCode: d.beam.power_code };
      opt(o, 'text', d.text);
      break;
    case 'telemetry':
      o.sequence = d.sequence ?? '';
      o.analog = d.analog ?? [];
      opt(o, 'bits', d.bits);
      opt(o, 'comment', d.comment);
      break;
    case 'weather':
      if (d.timestamp !== undefined) o.timestamp = timestampFrom(d.timestamp);
      o.weather = weatherFrom(d.weather ?? {});
      opt(o, 'comment', d.comment);
      break;
    case 'raw-weather':
      o.format = d.format;
      opt(o, 'data', d.data);
      break;
    case 'nmea':
      o.sentence = d.sentence ?? '';
      if (d.has_checksum) o.hasChecksum = true;
      opt(o, 'latitude', d.latitude);
      opt(o, 'longitude', d.longitude);
      opt(o, 'fix', d.fix);
      opt(o, 'courseDegrees', d.course_degrees);
      opt(o, 'speedKnots', d.speed_knots);
      opt(o, 'altitudeM', d.altitude_m);
      opt(o, 'time', d.time);
      opt(o, 'waypoint', d.waypoint);
      opt(o, 'comment', d.comment);
      break;
    case 'maidenhead-beacon':
      o.locator = d.locator ?? '';
      opt(o, 'comment', d.comment);
      break;
    case 'query':
      o.queryType = d.query_type ?? '';
      if (d.footprint)
        o.footprint = { latitude: d.footprint.latitude, longitude: d.footprint.longitude, radiusMiles: d.footprint.radius_miles };
      break;
    case 'capabilities':
      o.capabilities = d.capabilities ?? [];
      break;
    case 'user-defined':
      o.userId = d.user_id;
      o.packetType = d.packet_type;
      opt(o, 'data', d.data);
      break;
    case 'test':
      opt(o, 'data', d.data);
      break;
    case 'agrelo-df':
      o.bearingDegrees = d.bearing_degrees;
      o.quality = d.quality;
      break;
    case 'unrecognized':
      o.reason = d.reason;
      break;
    case 'third-party': {
      // The inner packet as data: its information field is written from its data, and its
      // diagnostics are kept, so one with a tolerated defect is refused, as the Encoding rule says.
      const p: J = d.packet ?? {};
      o.packet = {
        source: p.source ?? '',
        destination: p.destination ?? '',
        path: ((p.path ?? []) as string[]).map((e) => (e.endsWith('*') ? { address: e.slice(0, -1), used: true } : { address: e, used: false })),
        information: new Uint8Array(0),
        data: fromNeutralData(p.data ?? { type: 'unrecognized', reason: 'empty' }),
        diagnostics: ((p.diagnostics ?? []) as string[]).map(diagnosticFrom),
      };
      break;
    }
  }
  return o as unknown as AprsData;
}

/** A diagnostic from its neutral form, `severity:code`. */
function diagnosticFrom(text: string): Diagnostic {
  const colon = text.indexOf(':');
  return diagnostic(text.slice(0, colon) as Severity, text.slice(colon + 1) as DiagnosticCode);
}
