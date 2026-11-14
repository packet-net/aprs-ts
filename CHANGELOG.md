# Changelog

## Unreleased

A decoded packet now owns its bytes: `decodeTnc2`, `decodeAx25` and `decodeKiss` copy the information field instead of sharing memory with the caller's buffer, so a read loop that reuses its buffer no longer corrupts packets already decoded. `decodeKiss` and `unwrapKiss` throw `AprsHeaderError` (`not-aprs-frame`), not a `RangeError`, for an empty frame or a non-data KISS command. `toKiss(port)` and `wrapKiss` throw a `RangeError` unless the port is an integer 0-15, instead of masking it. The number patterns for telemetry values, equation coefficients and query footprints (decoder and encoder) take linear time on a long run of digits, with the same accepted text. README: the sibling libraries are listed and linked correctly, and the package is stated to be ESM only. The publish workflow refuses a tag or manual version that differs from package.json.

## 1.1.0 (2026-11-14)

The round 3 rulings of the conformance vectors (aprs-vectors#24), for 1.1.0. The vectors runner now checks the refusal code each case names, not only that the encoder refused.

Decoding. Third-party packets nest at most four deep: a fifth `}` is not read, and the packet it starts is `unrecognized` (`malformed`) with `error:invalid-third-party`, so a line of thousands of nested headers costs no more than five. An AX.25 address is upper-case letters and digits: a lower-case letter is still tolerated (`invalid-ax25-address-characters`), but any other character, a space before the last one included, is `invalid-address`, and a call of spaces only is read as an empty TNC2 address is (an empty source is `invalid-address`, an empty destination `empty-destination`, an empty digipeater `empty-path-entry` and left out of the path). In a weather report a `!DAO!` on an ambiguous position is met before the comment text left over, so a strict decoder rejects such a packet by `dao-with-ambiguity`, not `weather-comment`.

Encoding: which refusal code. Base-91 telemetry with no analog values is `malformed` (more than five is still `too-long`). A `!DAO!` digit datum with added precision is `invalid-code`. NMEA data is its sentence: a field left out is taken from the sentence and the sentence is written, and a comment after a sentence with no checksum is `invalid-nmea`. A third-party path entry before a used one that is not marked used is `invalid-third-party-header`. A field whose place exists but is wanted twice keeps its own checks before the conflict is named: every data extension given (a PHG digit of 10 beside a course is `value-out-of-range`), those on an uncompressed weather report, a course and speed on a compressed weather report, and a GGA altitude whose cs bytes a course or range also wants. A reply-ack that is wrong on its own is `invalid-message-id` even with no message ID. A query or directed query with no type is `invalid-code`, since absent text is empty text. Base-91 telemetry on a weather report is `field-not-allowed` and its own checks do not run. An object or item built by hand with no name is refused as `invalid-name` instead of throwing a `TypeError`.

Encoding: data built by hand. The encoder checks the shape of what it is given before reading it, so no public encoding call (`encodeInformation`, `encodeTnc2`, `encodeTnc2Bytes`, `encodeAx25`, `packetToTnc2`, `packetToAx25` and the builders) throws anything but an `AprsEncodeError` on any object. Text a report always has is empty text when left out: a missing name is `invalid-name`, a missing addressee `invalid-addressee`, a missing query type `invalid-code` and a missing or unusable positioned symbol `invalid-symbol`. Any other required field left out is `missing-field`, and a field of the wrong kind is `malformed`; that refusal waits until the rest of the record is checked, so a fault earlier in the Refusal reasons order wins, except for a missing NMEA sentence or third-party packet, without which nothing is left to check. Third-party data nested more than four deep is refused as `invalid-third-party-header`, before any fault inside it; the chain is walked without recursion, in the encoder and in the neutral-form conversion, so a caller-built chain 10,000 deep is refused, not a stack overflow.

The header comes first: a builder, `encodeTnc2`, `encodeTnc2Bytes` and `encodeAx25` check the source, destination and path before the data, so a bad source with an out-of-range course is `invalid-address` (or `ax25-cannot-carry`), not `value-out-of-range`.

Builder. A setter replaces its quantity whatever unit it was given in, so on a kept builder the last altitude setter wins again (`.altitudeFeet(1000).altitudeM(100)` sends 328 feet). This reverses 1.0.1, where `.altitudeFeet()` and `.altitudeM()` together were refused with `value-given-twice`; that refusal is now only for one input that carries the same quantity in two units at once, such as a weather input with `temperatureF` and `temperatureC`.

A weather input that gives one value in two units (`temperatureF` and `temperatureC`, say) has both values checked: the refusal is the first code in the order among both, the other faults and `value-given-twice`, which comes after `missing-field`, so an out-of-range value in either unit is `value-out-of-range`.

NaN and infinities are `not-a-number` wherever a check catches them: a compressed speed, range or ambiguity, a Mic-E altitude, and an NMEA field beside its sentence. An ambiguity of infinity no longer hangs the encoder.

The dump tool reads the `NaN`, `Infinity` and `-Infinity` tokens `generate.py --nonfinite` writes; builds a recipe giving one quantity in two units once with each unit and reports the first code among both results and `value-given-twice`, never `unsupported`; and gives a status recipe's `hms` or `mdhm` timestamp to the builder, which refuses it as `invalid-timestamp`.

### Behaviour changes for 1.x callers

- A lower-case locator in neutral or hand-built data (a status, a Mic-E report, a Maidenhead beacon) is refused as `malformed`; builders still upper-case it.
- An AX.25 address with punctuation, a space inside it or a control character is now `invalid-address`, and the frame is not decoded; only lower case is tolerated.
- Telemetry analog counts: too few is `malformed`, too many `too-long`.
- Third-party packets nest at most four deep, decoding and encoding.
- `.altitudeFeet()` then `.altitudeM()` on one builder is no longer refused; the last one wins.

## 1.0.1 (2026-11-12)

Refusals carry a reason code. `AprsEncodeError` has a new read-only `code` property, a `RefusalCode` from the shared list of 26 in the conformance vectors' `codes.json` (`refusals`), so a program can tell why the encoder or a builder refused without reading the message. `RefusalCode`, `REFUSAL_CODES` and `REFUSAL_MEANINGS` are exported. Additive only: the error class, its message text and every signature are unchanged. `code` is `does-not-read-back` only where the library's own read-back check fails and no named rule applies. New codes may be added in later 1.x releases, so allow an unknown one. A builder given an altitude in both feet and metres now refuses it with `value-given-twice`, as it already did for a weather value in two units; the last setter used to win.

Two rulings. A Mic-E locator at the start of the status text is read before a later altitude is looked for, and the altitude search never uses its bytes (`IO91/G}!:&0'p|` has no altitude, comment `}!:&0'p|`, a `missing-space-after-locator` warning). An AX.25 address written with SSID `-0` is refused with `ax25-cannot-carry`, as `-00` already was, for the outer and the third-party inner header.

## 1.0.0 (2026-11-10)

This is the first stable release. The public API is now frozen under semantic versioning. From 1.0 the major and minor version are shared with aprs-vectors: a ruling round is a minor version for all five implementations, this library's own fixes are patch versions, and an API break is a major version.

The 1.0 API cleanup. Everything below that is marked breaking is removed or renamed outright, with no deprecated alias left behind. The decoder and encoder are unchanged: the 100,000-line encode and build differential dumps and the decode dump over the 1,831 cases agree line for line with 0.3.0.

### Breaking changes

Builder setters take the name of the field they fill, with the unit in it:

- `.course(d)` is `.courseDegrees(d)`; `.speed(k)` is `.speedKnots(k)`; `.altitude(f)` is `.altitudeFeet(f)`; `.altitudeMetres(m)` is `.altitudeM(m)`; `.range(m)` is `.rangeMiles(m)`; `.speedKmh()` is unchanged.
- `.commentTelemetry(...)` is `.telemetry(...)`, like the `telemetry` field it fills.
- `PacketBuilder.telemetry(sequence, ...)` takes a number 0-999 only; a text sequence is still possible through hand-built data (`Aprs.from(...).data(...)`).
- `MicEBuilder.old()` is `.oldData()`; `MessageBuilder.id()` is `.messageId()`.

Weather and telemetry builders:

- `weather(lat, lon, w)` and `weatherReport(w, at)` are one method: `weather(w, { latitude, longitude, at? })` for a report with a position, `weather(w, { at? })` for a positionless one (`at` defaults to now).
- `telemetryNames`, `telemetryUnits`, `telemetryCoefficients` and `telemetryBits` take the addressee last, and it defaults to the sending station: `telemetryNames(names, addressee?)`, `telemetryUnits(units, addressee?)`, `telemetryCoefficients(coefficients, addressee?)`, `telemetryBits(bits, project?, addressee?)`.
- `WeatherInput` is exclusive per unit pair in the type: `{ temperatureF: 61, temperatureC: 16 }` no longer compiles (likewise `rain1hIn`/`rain1hMm`, `rain24hIn`/`rain24hMm`, `rainMidnightIn`/`rainMidnightMm`). A decoded `Weather` is still accepted. A caller the type does not stop gets the same `AprsEncodeError`, now thrown from `build()` and not from the middle of the chain.

Building and refusal:

- `build()` checks the source, destination and path addresses (APRS-IS form) and throws `AprsEncodeError` there. A `BuiltPacket` can always be written; its `toTnc2()`, `toTnc2Bytes()`, `toAx25()` and `toKiss()` reuse the stored information field and add only their own limits (AX.25 address form and 8 digipeaters; UTF-8 for `toTnc2()`).
- `BuiltPacket.path` is `readonly PathEntry[]` (`{ address, used }`), like `AprsPacket.path`; `via()` accepts `string | PathEntry` (a trailing `*` marks a string entry used).
- The builder classes (`PacketBuilder`, `PositionBuilder`, `ObjectBuilder`, `ItemBuilder`, `MicEBuilder`, `MessageBuilder`, `StatusBuilder`, `TelemetryBuilder`, `DataBuilder`) are exported as types only; start with `Aprs.from()`. They cannot be constructed or used with `instanceof`.

Data and decoding:

- `EncodedInformation.info` is `information`, and both fields are readonly.
- `decodeInformation(information, destination, options = ParseOptions.lenient)`: `options` is optional, and `DecodedInformation` has readonly fields.
- `MicEReport` gains `altitudeInComment`: set by the decoder when the altitude came from a `/A=` in the status text, honoured by the encoder, and not part of the vectors' neutral form. It replaces the hidden state the builder used, so encoding a copy of a built packet's data writes the same bytes.

Removed from the package root:

- `toNeutralData`, `toNeutralHeader`, `toNeutralPacket`, `fromNeutralData` and `Neutral`: the vectors' form is not public API.
- `bytesToHex`, `hexToBytes`, `encodeUtf8`, `decodeUtf8` (use `TextEncoder` and `TextDecoder`), and `diagnostic()`.

### Added

- `hasErrors(packet)`, `hasWarnings(packet)`, `phgValues(phg)` (`powerWatts`, `heightFeet`, `gainDb` and `directivityDegrees` from a PHG's codes), and `packetToTnc2(packet)`, `packetToTnc2Bytes(packet)` and `packetToAx25(packet)`, which write a received packet with its information field as received (`packetToAx25` throws `AprsEncodeError` for an address AX.25 cannot carry as sent).
- `diff-dump` writes the API view keys `has_errors`, `has_warnings`, `ax25` and `phg`.

### Fixed

- `decodeKiss` and `unwrapKiss` document that they throw `RangeError` for a frame that is not a KISS data frame.
- The encoder uses the exported `DEFAULT_DESTINATION`, not its own copy of `APZ001`.
- An AX.25 frame is refused for an SSID written with a leading zero (`WB4APR-00`), which it would give back as `WB4APR`.

## 0.3.0

- Brought into line with the exact-bytes batch 2 rulings (packet-net/aprs-vectors, commit f205471). Every value between the steps its field holds is rounded to the nearest, halves away from zero, a value within 1e-6 of a half (in steps) taken as the half, so a latitude of 0.9764166666666666 degrees is `0058.59N`; a `/A=` altitude is rounded to whole feet (-0.5 to `-00001`), where a fraction was refused; a snowfall is rounded to its three characters (0.995 as `001`, 9.96 as `010`); and a small negative compressed speed that rounds to s = 0 is 0.
- A course of 0 is refused in Mic-E, where it reads back as no course, and in a compressed report, where it reads back as 360. A compressed course without a speed, or a speed without a course, is refused.
- DF and storm data with no course and speed is written after `.../...`, and counts as the data extension, so with a PHG, RNG or DFS it is refused.
- Numbers given as data are plain decimals: `1e61` is `1` and 61 zeros, `1e-7` is `0.0000001`, `190.0` is `190`. A query footprint's latitude and longitude each get a leading space unless negative, 0 included (`?APRS? 0, 0,0200`).
- A compressed GGA altitude in a weather report, which has no comment for a `/A=`, is written as the nearest cs value.
- A third-party packet whose inner packet reads back with only `info` diagnostics is written, where it was refused.
- Mic-E: telemetry and the `!DAO!` are lifted before the locator is read, so a locator followed straight by either has no missing space, and the encoder writes them straight on (`IO91/G|!:&0'p|`); a locator is read only at the start of the status text (or after a Mic-E altitude there), so after a PHG or RNG `IO91SX/G` is text, written straight on; a PHG after a locator and its space is lifted before an altitude is looked for later in the text; with ambiguity, the longitude digits a decoder ignores are written as the centre it reports, where they held the position's own digits; and a comment that would join a PHG's digits into an altitude is written after a space when a `/` does not help.
- Device lookup is case-sensitive (`APNl02` matches nothing), and a third-party packet's inner packet has its own `device`.
- The builder: a course of 0 (or one that rounds to 0) is unknown, so Mic-E writes no course; `altitudeMetres()` on a Mic-E report uses the Mic-E altitude bytes, rounded to the metre, and `altitude()` a `/A=`; weather takes `temperatureC`, `rain1hMm`, `rain24hMm` and `rainMidnightMm` (the type `WeatherInput`), converted and rounded once; a telemetry sequence given as a number over 999 is refused, where it was written as four digits.
- Rulings G1-G3 (vectors commit 08cecbe): a cs value rounds to the nearest step of its formula for any whole s and is refused when that s is outside the byte, so a compressed speed of -0.03 knots is 0 and -0.3 is refused, and a range of 1.95 miles is 2 and 1.9 refused (a range under 2 was always refused); the ambiguity cut takes a value within 1e-6 of the box edge above it as on that edge (80.49 degrees with one level is 29.4x).
- Run 2 rulings (vectors commit 423a654): cs values with no compression type get the default type byte `C`, a third-party inner packet's too; in strict decoding, a Mic-E status text left as text is rejected (`mic-e-altitude-not-first`) when lifting its `!DAO!` would join bytes into another altitude; a Mic-E comment that a `/` would join into an altitude (`/{}`) is written after a space.
- A snowfall of `s` and three spaces is a weather field sent as unknown, not comment text (vectors commit a638990).
- Storm data's fields are digits: one holding a space (`> 90`) makes the whole of it comment text, and the encoder refuses storm data with a field missing. Strict Mic-E decoding reads as lenient when the status text has no later altitude to decline (vectors commit 1788661).
- Strict Mic-E decoding rejects a declined later altitude only when lifting telemetry or the `!DAO!` would join bytes across their place into another altitude, not when the text already held one (vectors commit 9c01dbd).
- Mic-E: a PHG or RNG that reaches the start of the status text only once a later altitude is lifted is late, with `data-extension-in-comment` (vectors commit e27a79f).
- `scripts/diff-dump.mjs` build mode passes Celsius and millimetre weather to the builder.

- The encoder writes exactly the bytes the vectors' Encoding rule gives (packet-net/aprs-vectors, exact-bytes batch 1), and the conformance test compares them with each case's `canonical_info` byte for byte, and checks the new `rounded` re-encoding.
- A position, object or item report's comment is written in one order: the voice frequency with its fields (in the first bytes, where radios read it), the signpost or corridor braces, the `/A=` altitude, the free text (after a space when a frequency comes before it), base-91 telemetry and the `!DAO!`. So `j006/058/146.520MHz/A=000889 Dayton Bound`, where it was `j006/058/A=000889146.520MHz Dayton Bound`; and braces are always written before the free text. A frequency straight after a seven-byte data extension follows a `/`.
- The `!DAO!` on a compressed position gets the digits a `!DAO!` of its precision gives the position the compressed bytes report (`!sCp!`), where it had zeros (`!s!!!`). A position's digits and its `!DAO!` digits are the nearest step of the `!DAO!`'s precision, so a remainder close to the next hundredth of a minute carries into it.
- Mic-E: a speed of 190-199 knots is written with `/`, the printable form, where it was DEL.
- A snowfall under 1 inch is `.` and two digits (0.5 as `.50`), where it was `0.5`.
- A value the compressed cs bytes carry in steps (a course or wind direction, a speed, a range) is rounded once, straight to the nearest step, halves away from zero; a course was first rounded to whole degrees. A compressed range under 2 miles is refused: the cs bytes cannot hold it. Everywhere else a value is rounded to a whole number, halves go away from zero (-12.5 to -13), where `Math.round` took them towards +infinity.
- **API change:** `Query.footprint` keeps each number as sent (`latitudeText`, `longitudeText`, a leading space included), and the encoder writes it back that way (`?APRS? 34.360,-.1715,0200`), where it wrote the number again (`34.36,-0.1715`). The footprint's type is exported as `QueryFootprint`.
- The builder has `speedKmh()`, a speed in km/h, beside `speed()` in knots.
- `fromNeutralData` builds third-party data too: the inner packet's data, header and diagnostics, with no information field, so the encoder writes the inner packet from its data.
- `scripts/diff-dump.mjs` has the vectors' encode (`--encode`) and build (`--build`) modes, and its decode records carry the bytes written (`written`, and `written_destination` for Mic-E) and the API view (`api`).

## 0.2.0

- Faster decoding, about a third less time per packet: the device a destination identifies is remembered rather than matched against the whole device database for every packet, and bytes become text without an intermediate copy.
- Brought into line with the rulings from seven rounds of differential fuzzing of all five implementations (packet-net/aprs-vectors, commit dc3854a, 159 new cases). Passes every check.
- **API change:** `NmeaSentence` gains `comment`, the text after the checksum as sent (TinyTrack and FreeTrak send one), and the neutral form writes it as `comment`. `sentence` now ends at the checksum. A sentence is `$`, an address of five upper-case letters or digits (or `P` and three or more), at least one field, printable ASCII, and at most one `*`, which must start a two-digit checksum; anything else is `invalid-nmea`, found before a checksum mismatch. Only GGA, GLL, RMC, VTG and WPL are read, and only from an approved address, so a proprietary sentence such as `$PGRMC` is kept as text. A position needs both coordinates, and a time must be in range. A speed, course or altitude may start with its decimal point (`.30`).
- **API change:** `CommentTelemetry.digital` is the eight binary channels, 0-255; bits 9-13 of the value are reserved and ignored, and the encoder refuses a value over 255. `Dao.datum` may be a digit, a local datum, which only carries precision `none`.
- Messages: an addressee field whose tenth byte is `:` is read as the addressee whatever it holds; `ack` or `rej` and an ID followed by anything but a message ID is a plain message; bulletins, NWS bulletins and telemetry metadata do not take the reply-ack form (`{12}` stays in the text, with `brace-in-message-text`); an `EQNS.` coefficient has no `+`, only spaces around it, and must be a finite number. A directed query's target may follow one space, and spaces after it are padding; the encoder pads an APRSH target to 9 characters and writes a target after a type the spec does not define after one space.
- Station capabilities: spaces (and only spaces) around an item, a token or a value are padding, so `MSG_CNT = 43` is `MSG_CNT` and `43`; a control character in a token or a value makes the report free text. The encoder refuses anything that would not read back the same.
- A general query footprint outside 90 degrees of latitude or 180 of longitude is `invalid-general-query`, a positive longitude may have a leading space, and each value is a number as a telemetry value is, so it may start with its decimal point (`-.1715`). An Agrelo DF report is exactly `%nnn/n` with a bearing of 0 to 360. A status `^` beam heading needs an ERP code of 1 to K; `^B0` is text.
- A third-party header's source may be any 1-9 printable ASCII characters but `>` and `:` (APRS12c ch. 17). A q-construct is read only in the outer header, so a third-party packet no longer has a `qConstruct` from its own path. A third-party packet whose inner information field is empty re-encodes as it came.
- Positions: a latitude whose ambiguity centres it past the pole (`90  .  N`) is `invalid-latitude`, and a longitude centred past 180 degrees is `invalid-longitude`; a longitude place the latitude's ambiguity blanks may hold a digit or a space; a DF bearing over 360 is `out-of-range-value` and the whole `/BRG/NRQ` is dropped; a microwave band letter is upper case (`n47.150MHz` is comment text); a `!DAO!` with a digit datum and spaces is read; a signpost is printable ASCII, and the encoder writes one with a space in it (`{5 }`), which it refused; a signpost or corridor is the first well-formed braces, so braces that do not qualify (`{AB}` before a corridor's `{5}`) no longer stop the search, and when a comment holds braces that would be taken for the signpost or corridor, the encoder writes the braces before the comment (`{5p5}{AB}`) instead of refusing; the `!DAO!` is judged before the comment's encoding; and a compressed GGA altitude of 1 foot or less is written as the nearest cs value with a `/A=`, where it was refused.
- Weather: the wind speed in a compressed weather position's cs bytes is converted from knots with the exact factor, 1852 / 1609.344, not a rounded one, so it agrees with the other implementations past the ninth significant figure. In a position, object or item report, the wind is judged where the `DDD/SSS` extension belongs, before any field, so strict decoding rejects missing wind or wind fields before a field's width; a `c` field without an `s` leaves the wind incomplete; `L` and `l` are one field; snowfall may be written with a decimal point (`s.50` is 0.5 inches), and a run of dots is read only up to the field's width, and is not a field when a digit follows it (`s..6` is text); the encoder writes a snowfall exactly in its three characters, with a decimal point where it needs one (0.32 as `.32`), where it refused 0.32 and 0.05; and a positionless report keeps base-91 telemetry and `!DAO!` text in its comment.
- Mic-E: the Rev 0 data type identifiers 0x1C and 0x1D get an `obsolete-format` info, before anything else is checked; a destination latitude of 90 degrees with blanked digits, whose centre is past the pole, is `invalid-mic-e-destination`; a data extension straight after the type code is read before an altitude is looked for later in the text, so `0PH}` in `PHG3330PH}` is not an altitude; a `!DAO!` is never read across an altitude taken out of the text; and status text that would start with 0x1D is written after a `/`, as APRS12c requires, where it was written plainly when it could not be read as Rev 0 telemetry.
- `scripts/diff-dump.mjs` re-decodes a re-encoded packet under a well-formed header (the computed destination for Mic-E), so a defect in the original header, such as an empty destination, is no longer counted against the encoder.

## 0.1.1

- Mic-E Rev 0 binary telemetry (0x1D and five bytes after the symbol) is read into `legacyTelemetry`, with an `obsolete-format` info, and written back; it was left in the comment and refused on encoding. A value of 255 is refused. The ruling is shared by all five implementations (packet-net/aprs-vectors, "Mic-E Rev 0 binary telemetry").

## 0.1.0

First release.

- Decoding of TNC2 / APRS-IS lines (text or bytes), AX.25 UI frames and KISS frames, into a typed data model covering every APRS data type, with diagnostics using the codes of the aprs-vectors conformance suite.
- Strict and lenient decoding, with each tolerable defect switchable on or off by itself (`ParseOptions`).
- An encoder for every data type that writes only what the spec allows and refuses anything else with a reason; free text is checked by decoding what was written. Mic-E encoding computes the destination address.
- A fluent builder (`Aprs.from(...)`) for positions, objects, items, Mic-E, messages and acks, status, weather, telemetry and telemetry metadata, bulletins.
- Every symbol the APRS tables define, by name (`Symbols.car`), with overlays (`withOverlay`).
- Device identification from the APRS device identification database (commit 845e3f89).
- Passes every check of aprs-vectors (commit a16bde8, 5,523 checks); `scripts/diff-dump.mjs` writes the differential dump its `tools/compare.py` reads.
