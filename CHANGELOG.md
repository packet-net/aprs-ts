# Changelog

## Unreleased

- Faster decoding, about a third less time per packet: the device a destination identifies is remembered rather than matched against the whole device database for every packet, and bytes become text without an intermediate copy.
- Brought into line with the rulings from differential fuzzing of all five implementations (packet-net/aprs-vectors, commit 5ee2267, 120 new cases). Passes every check but the two of `corpus/0686`, an observed record from before the NMEA ruling that the vectors are to refresh.
- **API change:** `NmeaSentence` gains `comment`, the text after the checksum as sent (TinyTrack and FreeTrak send one), and the neutral form writes it as `comment`. `sentence` now ends at the checksum. A sentence is `$`, an address of five upper-case letters or digits (or `P` and three or more), at least one field, printable ASCII, and at most one `*`, which must start a two-digit checksum; anything else is `invalid-nmea`, found before a checksum mismatch. Only GGA, GLL, RMC, VTG and WPL are read, and only from an approved address, so a proprietary sentence such as `$PGRMC` is kept as text. A position needs both coordinates, and a time must be in range.
- **API change:** `CommentTelemetry.digital` is the eight binary channels, 0-255; bits 9-13 of the value are reserved and ignored, and the encoder refuses a value over 255. `Dao.datum` may be a digit, a local datum, which only carries precision `none`.
- Messages: an addressee field whose tenth byte is `:` is read as the addressee whatever it holds; `ack` or `rej` and an ID followed by anything but a message ID is a plain message; bulletins, NWS bulletins and telemetry metadata do not take the reply-ack form (`{12}` stays in the text, with `brace-in-message-text`); an `EQNS.` coefficient has no `+`, only spaces around it, and must be a finite number. A directed query's target may follow one space, and spaces after it are padding; the encoder pads an APRSH target to 9 characters and writes a target after a type the spec does not define after one space.
- Station capabilities: spaces (and only spaces) around an item, a token or a value are padding, so `MSG_CNT = 43` is `MSG_CNT` and `43`; a control character in a token or a value makes the report free text. The encoder refuses anything that would not read back the same.
- A general query footprint outside 90 degrees of latitude or 180 of longitude is `invalid-general-query`, and a positive longitude may have a leading space. An Agrelo DF report is exactly `%nnn/n` with a bearing of 0 to 360. A status `^` beam heading needs an ERP code of 1 to K; `^B0` is text.
- A third-party header's source may be any 1-9 printable ASCII characters but `>` and `:` (APRS12c ch. 17). A third-party packet whose inner information field is empty re-encodes as it came.
- Positions: a longitude place the latitude's ambiguity blanks may hold a digit or a space; a microwave band letter is upper case (`n47.150MHz` is comment text); a `!DAO!` with a digit datum and spaces is read; a signpost is printable ASCII; the `!DAO!` is judged before the comment's encoding; and a compressed GGA altitude of 1 foot or less is written as the nearest cs value with a `/A=`, where it was refused.
- Weather: in a position, object or item report, the wind is judged where the `DDD/SSS` extension belongs, before any field, so strict decoding rejects missing wind or wind fields before a field's width; a `c` field without an `s` leaves the wind incomplete; `L` and `l` are one field; and a positionless report keeps base-91 telemetry and `!DAO!` text in its comment.
- Mic-E: the Rev 0 data type identifiers 0x1C and 0x1D get an `obsolete-format` info, before anything else is checked; a data extension straight after the type code is read before an altitude is looked for later in the text, so `0PH}` in `PHG3330PH}` is not an altitude; and a `!DAO!` is never read across an altitude taken out of the text.
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
