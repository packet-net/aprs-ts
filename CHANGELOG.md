# Changelog

## Unreleased

- Faster decoding, about a third less time per packet: the device a destination identifies is remembered rather than matched against the whole device database for every packet, and bytes become text without an intermediate copy.

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
