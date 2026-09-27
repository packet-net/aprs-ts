// The diagnostic codes, one for each code in the conformance vectors' codes.json.
// Generated from vectors/codes.json; keep in step with it.

/** Every diagnostic code the decoder can report. */
export type DiagnosticCode =
  | 'invalid-header'
  | 'invalid-address'
  | 'empty-destination'
  | 'empty-path-entry'
  | 'multiple-used-markers'
  | 'not-aprs-frame'
  | 'nul-padded-address'
  | 'invalid-ax25-address-characters'
  | 'too-many-digipeaters'
  | 'trailing-line-break'
  | 'non-utf8-text'
  | 'truncated'
  | 'not-aprs'
  | 'reserved-data-type'
  | 'obsolete-format'
  | 'out-of-range-value'
  | 'invalid-timestamp'
  | 'invalid-position'
  | 'invalid-latitude'
  | 'invalid-longitude'
  | 'lowercase-hemisphere'
  | 'invalid-symbol-table'
  | 'invalid-symbol-code'
  | 'invalid-compressed-position'
  | 'dao-with-ambiguity'
  | 'data-extension-in-comment'
  | 'invalid-object-name'
  | 'object-name-not-padded'
  | 'object-without-timestamp'
  | 'invalid-item-name'
  | 'incomplete-weather'
  | 'weather-comment'
  | 'invalid-weather'
  | 'invalid-mic-e-destination'
  | 'invalid-mic-e-information'
  | 'kenwood-ff-padding'
  | 'mic-e-missing-device-type'
  | 'invalid-message'
  | 'unpadded-addressee'
  | 'message-id-on-ack'
  | 'invalid-telemetry-metadata'
  | 'invalid-query'
  | 'invalid-telemetry'
  | 'invalid-status'
  | 'invalid-locator'
  | 'invalid-nmea'
  | 'nmea-checksum-mismatch'
  | 'invalid-third-party'
  | 'invalid-general-query'
  | 'invalid-capabilities'
  | 'invalid-user-defined'
  | 'invalid-agrelo-df'
  | 'missing-space-after-locator'
  | 'compression-type-reserved-bits'
  | 'malformed-timestamp'
  | 'position-not-at-start'
  | 'non-standard-weather-field-width'
  | 'wind-fields-instead-of-extension'
  | 'wind-extension-after-compressed'
  | 'mic-e-altitude-not-first'
  | 'brace-in-message-text'
  | 'invalid-addressee-characters'
  | 'letter-group-bulletin'
  | 'free-text-capabilities';

/** The codes a lenient decoder may accept with a warning; a strict decoder rejects them. */
export type TolerableCode =
  | 'empty-destination'
  | 'empty-path-entry'
  | 'multiple-used-markers'
  | 'nul-padded-address'
  | 'invalid-ax25-address-characters'
  | 'trailing-line-break'
  | 'non-utf8-text'
  | 'out-of-range-value'
  | 'invalid-timestamp'
  | 'lowercase-hemisphere'
  | 'dao-with-ambiguity'
  | 'data-extension-in-comment'
  | 'object-name-not-padded'
  | 'object-without-timestamp'
  | 'incomplete-weather'
  | 'weather-comment'
  | 'kenwood-ff-padding'
  | 'unpadded-addressee'
  | 'message-id-on-ack'
  | 'invalid-telemetry'
  | 'missing-space-after-locator'
  | 'compression-type-reserved-bits'
  | 'malformed-timestamp'
  | 'position-not-at-start'
  | 'non-standard-weather-field-width'
  | 'wind-fields-instead-of-extension'
  | 'wind-extension-after-compressed'
  | 'mic-e-altitude-not-first'
  | 'brace-in-message-text'
  | 'invalid-addressee-characters'
  | 'letter-group-bulletin'
  | 'free-text-capabilities';

/** What each code means, in plain ASCII. */
export const DIAGNOSTIC_MEANINGS: Readonly<Record<DiagnosticCode, string>> = {
  'invalid-header': "The TNC2 header is not SOURCE>DEST[,PATH]:.",
  'invalid-address': "An address is empty, too long, or has characters that cannot appear in one.",
  'empty-destination': "The destination address is empty (UAP 5.2).",
  'empty-path-entry': "The digipeater path has an empty entry (UAP 5.6).",
  'multiple-used-markers': "More than one path entry is marked used with *; only the last used one should be (UAP 5.30).",
  'not-aprs-frame': "The AX.25 frame is not a UI frame with PID 0xF0, or is too short (APRS12c ch. 3).",
  'nul-padded-address': "An AX.25 address is padded with NUL rather than spaces (UAP 5.29).",
  'invalid-ax25-address-characters': "An AX.25 address has characters other than upper-case letters and digits.",
  'too-many-digipeaters': "The AX.25 frame has more than 8 digipeater addresses.",
  'trailing-line-break': "The information field ends with CR or LF (APRS12c ch. 5, UAP 5.13).",
  'non-utf8-text': "Text that is not valid UTF-8 (UAP 5.16).",
  'truncated': "The information field is shorter than its format requires.",
  'not-aprs': "The first byte is not a data type identifier (APRS12c ch. 20).",
  'reserved-data-type': "A reserved data type identifier with no defined format (APRS12c ch. 5).",
  'obsolete-format': "A format the spec marks obsolete or not recommended, e.g. raw NMEA, raw weather, or the Rev 0 Mic-E data type identifiers 0x1C and 0x1D.",
  'out-of-range-value': "A value in a well-formed field is out of range and was dropped.",
  'invalid-timestamp': "A timestamp is malformed or out of range (APRS12c ch. 6, UAP 5.8).",
  'invalid-position': "The position is missing or starts with something that cannot begin one.",
  'invalid-latitude': "The latitude is malformed (APRS12c ch. 6, UAP 5.7).",
  'invalid-longitude': "The longitude is malformed (APRS12c ch. 6, UAP 5.7).",
  'lowercase-hemisphere': "A lower-case hemisphere letter (UAP 5.9).",
  'invalid-symbol-table': "The symbol table identifier is not /, \\, 0-9 or A-Z.",
  'invalid-symbol-code': "The symbol code is not printable ASCII.",
  'invalid-compressed-position': "A compressed position is malformed (APRS12c ch. 9).",
  'dao-with-ambiguity': "A !DAO! adds precision to an ambiguous position, which contradicts it.",
  'data-extension-in-comment': "A data extension (PHG, RNG, DFS) appears later in the comment (UAP 5.15).",
  'invalid-object-name': "The object name is empty or not printable ASCII.",
  'object-name-not-padded': "The object name is not padded to 9 characters.",
  'object-without-timestamp': "An object report has no timestamp (APRS12c ch. 11).",
  'invalid-item-name': "The item name is not 3-9 printable characters followed by ! or _.",
  'incomplete-weather': "A weather report lacks a mandatory field (APRS12c ch. 12).",
  'weather-comment': "Text after the weather data; weather reports have no comment (UAP 2.7.1, ch. 5.33).",
  'invalid-weather': "Positionless or raw weather data that could not be decoded.",
  'invalid-mic-e-destination': "The destination address is not a valid Mic-E encoding (APRS12c ch. 10).",
  'invalid-mic-e-information': "The Mic-E information field is malformed (APRS12c ch. 10).",
  'kenwood-ff-padding': "Kenwood TM-D710 0xFF padding was removed from Mic-E status text, after the destination and the nine fixed bytes decoded (UAP 5.10).",
  'mic-e-missing-device-type': "A Mic-E report without a device type prefix (UAP 5.4).",
  'invalid-message': "A message is malformed (APRS12c ch. 14).",
  'unpadded-addressee': "The addressee is not padded to 9 characters.",
  'message-id-on-ack': "An ack or rej carries a message ID of its own (UAP 5.32).",
  'invalid-telemetry-metadata': "A telemetry metadata message (PARM/UNIT/EQNS/BITS) is malformed (APRS12c ch. 13).",
  'invalid-query': "A directed query is malformed (APRS12c ch. 15, UAP 5.18).",
  'invalid-telemetry': "A telemetry report is malformed (APRS12c ch. 13).",
  'invalid-status': "A status report is malformed (APRS12c ch. 16).",
  'invalid-locator': "A Maidenhead locator is malformed.",
  'invalid-nmea': "The text after $ is not an NMEA 0183 sentence: not printable ASCII, no valid address field, or a reserved character in a field.",
  'nmea-checksum-mismatch': "An NMEA sentence's checksum does not match, so the sentence is corrupt and is not decoded.",
  'invalid-third-party': "A third-party header is malformed, or (strict) its inner header has a defect a lenient decoder tolerates (APRS12c ch. 17).",
  'invalid-general-query': "A general query is malformed, or its footprint is out of range (APRS12c ch. 15).",
  'invalid-capabilities': "A station capabilities report is malformed (APRS12c ch. 15).",
  'invalid-user-defined': "A user-defined packet is shorter than its 3-byte header (APRS12c ch. 19).",
  'invalid-agrelo-df': "An Agrelo DF report is not exactly %, a bearing of 000 to 360, / and a quality digit.",
  'missing-space-after-locator': "A grid-locator status report lacks the mandatory space before its text (UAP 5.17).",
  'compression-type-reserved-bits': "A compressed position's type byte sets its unused high bits (APRS12c ch. 9).",
  'malformed-timestamp': "A timestamped position report whose timestamp is missing or not timestamp-shaped (UAP 5.8).",
  'position-not-at-start': "A ! position found after other text (obsolete TNC beacon rule).",
  'non-standard-weather-field-width': "A weather field is one character shorter or longer than its fixed width (UAP 5.31).",
  'wind-fields-instead-of-extension': "Wind sent as c/s fields in a position weather report instead of the DDD/SSS extension, or after a compressed position whose cs bytes carry no wind.",
  'wind-extension-after-compressed': "An uncompressed wind extension after a compressed weather position (UAP 5.33).",
  'mic-e-altitude-not-first': "A Mic-E altitude after other status text instead of first (APRS12c ch. 10).",
  'brace-in-message-text': "Message, bulletin or telemetry metadata text contains a { that does not start a valid message ID, including the reply-ack form on a bulletin or metadata (APRS12c ch. 14).",
  'invalid-addressee-characters': "A message addressee contains a space or : (APRS12c ch. 14).",
  'letter-group-bulletin': "A bulletin addressee has a group name after a letter, e.g. BLNCNET; group bulletins use a digit (APRS12c ch. 14).",
  'free-text-capabilities': "A < station capabilities packet holds free text rather than TOKEN / TOKEN=VALUE items: a token that is empty or holds a space or a control character, or a value that holds a control character (APRS12c ch. 15).",
};

/** Every tolerable code. */
export const TOLERABLE_CODES: readonly TolerableCode[] = [
  'empty-destination',
  'empty-path-entry',
  'multiple-used-markers',
  'nul-padded-address',
  'invalid-ax25-address-characters',
  'trailing-line-break',
  'non-utf8-text',
  'out-of-range-value',
  'invalid-timestamp',
  'lowercase-hemisphere',
  'dao-with-ambiguity',
  'data-extension-in-comment',
  'object-name-not-padded',
  'object-without-timestamp',
  'incomplete-weather',
  'weather-comment',
  'kenwood-ff-padding',
  'unpadded-addressee',
  'message-id-on-ack',
  'invalid-telemetry',
  'missing-space-after-locator',
  'compression-type-reserved-bits',
  'malformed-timestamp',
  'position-not-at-start',
  'non-standard-weather-field-width',
  'wind-fields-instead-of-extension',
  'wind-extension-after-compressed',
  'mic-e-altitude-not-first',
  'brace-in-message-text',
  'invalid-addressee-characters',
  'letter-group-bulletin',
  'free-text-capabilities',
];

const tolerableSet: ReadonlySet<string> = new Set<string>(TOLERABLE_CODES);

/** Whether a code is one a lenient decoder may tolerate. */
export function isTolerable(code: DiagnosticCode): code is TolerableCode {
  return tolerableSet.has(code);
}

/** Every diagnostic code. */
export const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = Object.keys(DIAGNOSTIC_MEANINGS) as DiagnosticCode[];
