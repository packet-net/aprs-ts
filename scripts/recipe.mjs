// The builder recipes of aprs-vectors ("Build records", and the `build` input of a case), mapped
// onto this library's builder API. Shared by the dump tool's build mode (scripts/diff-dump.mjs,
// which passes the built library in dist/) and the vectors test runner (test/vectors.test.ts,
// which passes src/), so that both call the builder the same way.
//
// Only the keys a recipe gives are passed on: an absent one is never filled in, so the builder's
// own defaults show.

/**
 * @param lib `{ Aprs, AprsEncodeError, refusalRank }` of the library to build with.
 * @returns `buildRecipe(n, recipe)`: `{ n, result: 'built', bytes }` (the TNC2 line), or
 *   `{ n, result: 'refused' | 'unsupported', reason, refusal? }`.
 */
export function recipeBuilder({ Aprs, AprsEncodeError, refusalRank }) {
  /** An encoder refusal, or a builder declining a value (a symbol it cannot make, say). */
  function refusalCode(e) {
    // A RangeError is the builder's symbol constructor declining a symbol.
    return e instanceof AprsEncodeError ? e.code : 'invalid-symbol';
  }

  function isRefusal(e) {
    return e instanceof AprsEncodeError || e instanceof RangeError;
  }

  class Unsupported extends Error {}

  function unsupported(key, why) {
    throw new Unsupported(`${key}: ${why}`);
  }

  /** Checks every key of `args` is one the builder can express for this report. */
  function checkKeys(args, known, report) {
    for (const key of Object.keys(args)) {
      if (!known.has(key)) unsupported(key, `the aprs-ts builder has no way to give it for a ${report}`);
    }
  }

  const POSITIONED_OPTIONS = [
    'symbol',
    'course_degrees',
    'speed_knots',
    'speed_kmh',
    'altitude_feet',
    'altitude_m',
    'comment',
    'frequency',
    'ambiguity',
    'dao',
    'telemetry',
  ];
  const REPORT_OPTIONS = [...POSITIONED_OPTIONS, 'phg', 'range_miles', 'compressed'];

  const WEATHER_VALUES = {
    wind_direction_degrees: 'windDirectionDegrees',
    wind_speed_mph: 'windSpeedMph',
    wind_gust_mph: 'windGustMph',
    temperature_f: 'temperatureF',
    rain_1h_in: 'rain1hIn',
    rain_24h_in: 'rain24hIn',
    rain_midnight_in: 'rainMidnightIn',
    humidity_percent: 'humidityPercent',
    pressure_mbar: 'pressureMbar',
    luminosity_w_m2: 'luminosityWM2',
    snow_24h_in: 'snow24hIn',
    temperature_c: 'temperatureC',
    rain_1h_mm: 'rain1hMm',
    rain_24h_mm: 'rain24hMm',
    rain_midnight_mm: 'rainMidnightMm',
  };
  /**
   * Positioned recipe keys for one quantity in two units. The builder takes one unit per setter, so
   * a recipe giving both is built once with each unit, and the refusal is the first code in the
   * order among both results and value-given-twice (vectors README, Builder rules).
   */
  const UNIT_PAIRS = [
    ['speed_knots', 'speed_kmh'],
    ['altitude_feet', 'altitude_m'],
  ];

  /** A recipe timestamp as the builder takes it: a Date and the form to write. */
  function when(t) {
    if (!t || typeof t.utc !== 'string') unsupported('timestamp', 'it has no utc time');
    const date = new Date(t.utc);
    if (Number.isNaN(date.getTime())) unsupported('timestamp', `${t.utc} is not a time`);
    return { date, format: t.format };
  }

  /** A position or object timestamp: `dhm` or `hms`. */
  function reportTimestamp(t) {
    const { date, format } = when(t);
    if (format === 'dhm') return { date, kind: 'dhm-zulu' };
    if (format === 'hms') return { date, kind: 'hms' };
    return unsupported('timestamp', `the builder writes a ${format} timestamp only on a positionless weather report`);
  }

  /** The positioned options, on a position, object, item or Mic-E builder. */
  function positioned(b, args, report) {
    if (args.symbol !== undefined) b.symbol(args.symbol);
    if (args.course_degrees !== undefined) b.courseDegrees(args.course_degrees);
    if (args.speed_knots !== undefined) b.speedKnots(args.speed_knots);
    if (args.speed_kmh !== undefined) b.speedKmh(args.speed_kmh);
    if (args.altitude_feet !== undefined) b.altitudeFeet(args.altitude_feet);
    if (args.altitude_m !== undefined) b.altitudeM(args.altitude_m);
    if (args.comment !== undefined) b.comment(args.comment);
    if (args.frequency !== undefined) {
      const f = args.frequency;
      for (const key of Object.keys(f)) {
        if (!['mhz', 'tone', 'tone_value', 'offset_khz'].includes(key)) unsupported(`frequency.${key}`, 'not a recipe key');
      }
      const details = {};
      if (f.tone !== undefined) details.tone = f.tone;
      if (f.tone_value !== undefined) details.toneValue = f.tone_value;
      if (f.offset_khz !== undefined) details.offsetKhz = f.offset_khz;
      b.frequency(f.mhz, details);
    }
    if (args.ambiguity !== undefined) b.ambiguity(args.ambiguity);
    if (args.dao === true) b.dao();
    if (args.telemetry !== undefined) b.telemetry(args.telemetry.sequence, args.telemetry.analog ?? [], args.telemetry.digital);
    if (report !== 'mic-e') {
      if (args.phg !== undefined) b.phg(args.phg.power, args.phg.height, args.phg.gain, args.phg.directivity, args.phg.beacons_per_hour);
      if (args.range_miles !== undefined) b.rangeMiles(args.range_miles);
      if (args.compressed === true) b.compressed();
    }
    return b;
  }

  /** Weather for the builder's one weather input, which takes a value in two units and refuses it, ranked. */
  function weatherOf(args) {
    const w = {};
    for (const [key, field] of Object.entries(WEATHER_VALUES)) if (args[key] !== undefined) w[field] = args[key];
    return w;
  }

  function builderFor(recipe) {
    const { station, report, args } = recipe;
    for (const key of Object.keys(station)) {
      if (!['source', 'destination', 'path'].includes(key)) unsupported(`station.${key}`, 'not a station key');
    }
    let p = Aprs.from(station.source);
    if (station.destination !== undefined) p = p.to(station.destination);
    if (station.path !== undefined && station.path.length > 0) p = p.via(...station.path);
    const a = args;
    switch (report) {
      case 'position': {
        checkKeys(a, new Set(['latitude', 'longitude', 'messaging', 'timestamp', ...REPORT_OPTIONS]), report);
        const b = positioned(p.position(a.latitude, a.longitude), a, report);
        if (a.messaging === true) b.messaging();
        if (a.timestamp !== undefined) {
          const t = reportTimestamp(a.timestamp);
          b.timestamp(t.date, t.kind);
        }
        return b;
      }
      case 'object': {
        checkKeys(a, new Set(['name', 'latitude', 'longitude', 'timestamp', 'killed', ...REPORT_OPTIONS]), report);
        const b = positioned(p.object(a.name, a.latitude, a.longitude), a, report);
        // An object with no timestamp is the builder's to refuse (missing-field): it never reads the clock.
        if (a.timestamp !== undefined) {
          const t = reportTimestamp(a.timestamp);
          b.timestamp(t.date, t.kind);
        }
        if (a.killed === true) b.killed();
        return b;
      }
      case 'item': {
        checkKeys(a, new Set(['name', 'latitude', 'longitude', 'killed', ...REPORT_OPTIONS]), report);
        const b = positioned(p.item(a.name, a.latitude, a.longitude), a, report);
        if (a.killed === true) b.killed();
        return b;
      }
      case 'mic-e': {
        checkKeys(a, new Set(['latitude', 'longitude', 'mic_e_message', 'messaging', ...POSITIONED_OPTIONS]), report);
        const b = positioned(p.micE(a.latitude, a.longitude), a, report);
        if (a.mic_e_message !== undefined) b.micEMessage(a.mic_e_message);
        // The type code says whether the sender takes messages: ` if so, ' if not; left alone when the recipe is silent.
        if (a.messaging !== undefined) b.messaging(a.messaging === true);
        return b;
      }
      case 'weather': {
        const known = new Set(['latitude', 'longitude', 'symbol', 'timestamp', ...Object.keys(WEATHER_VALUES)]);
        checkKeys(a, known, report);
        const w = weatherOf(a);
        if (a.latitude !== undefined || a.longitude !== undefined) {
          const b = p.weather(w, { latitude: a.latitude, longitude: a.longitude });
          if (a.symbol !== undefined) b.symbol(a.symbol);
          if (a.timestamp !== undefined) {
            const t = reportTimestamp(a.timestamp);
            b.timestamp(t.date, t.kind);
          }
          return b;
        }
        if (a.symbol !== undefined) unsupported('symbol', 'a positionless weather report has no symbol');
        // With no timestamp the builder refuses (missing-field): it never reads the clock.
        if (a.timestamp === undefined) return p.weather(w);
        const { date, format } = when(a.timestamp);
        if (format !== 'mdhm') unsupported('timestamp', `a positionless weather report's timestamp is mdhm, not ${format}`);
        return p.weather(w, { at: date });
      }
      case 'message': {
        checkKeys(a, new Set(['addressee', 'text', 'message_id', 'reply_ack']), report);
        const b = p.message(a.addressee, a.text ?? '');
        if (a.message_id !== undefined) b.messageId(a.message_id);
        if (a.reply_ack !== undefined) b.replyAck(a.reply_ack);
        return b;
      }
      case 'ack':
      case 'reject':
        checkKeys(a, new Set(['addressee', 'message_id']), report);
        return report === 'ack' ? p.ack(a.addressee, a.message_id) : p.reject(a.addressee, a.message_id);
      case 'bulletin':
        checkKeys(a, new Set(['id', 'group', 'text']), report);
        return p.bulletin(a.id, a.text ?? '', a.group ?? '');
      case 'status': {
        checkKeys(a, new Set(['text', 'timestamp', 'locator', 'symbol', 'beam']), report);
        const b = p.status(a.text);
        if (a.timestamp !== undefined) {
          const { date, format } = when(a.timestamp);
          if (format === 'dhm') b.timestamp(date);
          // Any other form is given as it is, for the encoder to refuse (invalid-timestamp).
          else if (format === 'hms') b.timestamp({ kind: 'hms', hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() });
          else if (format === 'mdhm') b.timestamp({ kind: 'mdhm', month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() });
          else unsupported('timestamp', `${format} is not a timestamp form`);
        }
        // A locator and a symbol are given apart: one without the other is the builder's to refuse (missing-field).
        if (a.locator !== undefined) b.locator(a.locator, a.symbol);
        else if (a.symbol !== undefined) b.symbol(a.symbol);
        if (a.beam !== undefined) b.beam(a.beam.heading_code, a.beam.power_code);
        return b;
      }
      case 'telemetry': {
        checkKeys(a, new Set(['sequence', 'analog', 'bits', 'comment']), report);
        // The builder takes the analog values as an argument: with none given, the five channels are empty.
        const b = p.telemetry(a.sequence, a.analog ?? [null, null, null, null, null], a.bits);
        if (a.comment !== undefined) b.comment(a.comment);
        return b;
      }
      case 'telemetry-names':
        checkKeys(a, new Set(['names', 'addressee']), report);
        return p.telemetryNames(a.names, a.addressee);
      case 'telemetry-units':
        checkKeys(a, new Set(['units', 'addressee']), report);
        return p.telemetryUnits(a.units, a.addressee);
      case 'telemetry-coefficients':
        checkKeys(a, new Set(['coefficients', 'addressee']), report);
        return p.telemetryCoefficients(a.coefficients, a.addressee);
      case 'telemetry-bits':
        checkKeys(a, new Set(['bits', 'project', 'addressee']), report);
        return p.telemetryBits(a.bits, a.project, a.addressee);
      default:
        return unsupported('report', `the aprs-ts builder has no ${report} report`);
    }
  }

  /** Builds a recipe: the packet, or the refusal or unsupported record. */
  function buildOnce(n, recipe) {
    try {
      return { packet: builderFor(recipe).build() };
    } catch (e) {
      if (e instanceof Unsupported) return { record: { n, result: 'unsupported', reason: e.message } };
      if (isRefusal(e)) return { record: { n, result: 'refused', reason: e.message, refusal: refusalCode(e), ...(e instanceof AprsEncodeError && e.informationSize ? { size: true } : {}) } };
      throw e;
    }
  }

  function buildRecipe(n, recipe) {
    const args = recipe.args ?? {};
    const twice = UNIT_PAIRS.filter(([a, b]) => args[a] !== undefined && args[b] !== undefined);
    if (twice.length > 0) {
      // Once with each unit, never a line built from one of them.
      const without = (i) => {
        const a = { ...args };
        for (const pair of twice) delete a[pair[i]];
        return { ...recipe, args: a };
      };
      const results = [buildOnce(n, without(1)), buildOnce(n, without(0))].map((r) => r.record ?? { result: 'built' });
      const other = results.find((r) => r.result === 'unsupported');
      if (other) return other;
      const refusals = results.filter((r) => r.result === 'refused');
      refusals.push({ n, result: 'refused', reason: `${twice.map((p) => p.join(' and ')).join(', ')} given together`, refusal: 'value-given-twice' });
      // A result refused only for the information field's size counts after value-given-twice.
      const rank = (r) => (r.size ? Number.MAX_SAFE_INTEGER : refusalRank(r.refusal));
      const best = refusals.reduce((b, r) => (rank(r) < rank(b) ? r : b));
      const { size, ...record } = best;
      return record;
    }
    const once = buildOnce(n, recipe);
    if (once.record) return once.record;
    return { n, result: 'built', bytes: once.packet.toTnc2Bytes() };
  }

  return { buildRecipe };
}
