# @packet-net/pdn-aprs

An APRS (Automatic Packet Reporting System) encoder and decoder for TypeScript.

- Decodes TNC2 / APRS-IS lines and AX.25 frames into a typed data model, with every defect it noticed reported as a diagnostic.
- Every APRS data type: positions (plain, compressed, Mic-E), objects and items, weather, telemetry, messages and acks, bulletins, status, queries, capabilities, third-party traffic, NMEA, raw weather, user-defined data and the rest.
- Strict and lenient decoding, with each tolerated defect switchable on or off by itself.
- An encoder for every type that writes only what the spec allows, and refuses anything else with a reason.
- A fluent builder for the packets an application usually sends.
- Every APRS symbol by name, with overlays; device identification from the APRS device database.
- Zero runtime dependencies; ESM; works in browsers and Node 20 and later. Bytes are `Uint8Array`.

It is conformance tested against [aprs-vectors](https://github.com/packet-net/aprs-vectors), the language-neutral test suite shared with [Packet.Aprs](https://github.com/packet-net/packet.net) (C#), [pdn-aprs](https://github.com/packet-net/aprs-rs) (Rust) and [pdn-aprs](https://github.com/packet-net/aprs-py) (Python), and agrees with the C# and Rust implementations over a 6.9-million-packet APRS-IS capture.

## Install

```sh
npm install @packet-net/pdn-aprs
```

## Decoding

```ts
import { decodeTnc2 } from '@packet-net/pdn-aprs';

const packet = decodeTnc2('M0LTE-9>APDR16,WIDE1-1,qAR,G4ABC-10:=5127.00N/00058.80W>088/036/A=000100 Mobile');

console.log(packet.source); // M0LTE-9
console.log(packet.qConstruct?.station); // G4ABC-10
console.log(packet.device?.model); // APRSdroid

if (packet.data.type === 'position') {
  console.log(packet.data.latitude); // 51.45
  console.log(packet.data.courseDegrees); // 88
  console.log(packet.data.altitudeFeet); // 100
  console.log(packet.data.comment); // Mobile
}
```

`packet.data` is a discriminated union on `type`, so TypeScript narrows it for you: `position`, `mic-e`, `object`, `item`, `message`, `ack`, `reject`, `bulletin`, `nws-bulletin`, `telemetry`, `telemetry-names`, `telemetry-units`, `telemetry-coefficients`, `telemetry-bits`, `directed-query`, `status`, `weather`, `raw-weather`, `nmea`, `maidenhead-beacon`, `query`, `capabilities`, `third-party`, `user-defined`, `test`, `agrelo-df`, and `unrecognized` when there is nothing to decode. Quantities keep the units APRS sends them in, with the unit in the name (`speedKnots`, `altitudeFeet`, `temperatureF`).

A Mic-E report carries half its position in the destination address; the decoder reads both.

```ts
import { decodeTnc2 } from '@packet-net/pdn-aprs';

const micE = decodeTnc2('N0CALL>S32UVT:`(_fn"Oj/');
if (micE.data.type === 'mic-e') {
  console.log(micE.data.micEMessage); // returning
  console.log(micE.data.longitude); // -112.129
  console.log(micE.data.speedKnots); // 20
}
```

AX.25 frames (address, control, PID and information fields, no flags or FCS) decode with `decodeAx25`, and frames straight from a KISS TNC with `decodeKiss`.

## Diagnostics, strict and lenient

Real packets are often not quite right. The decoder reports everything it noticed, each with a severity and a code from the vectors' [codes.json](https://github.com/packet-net/aprs-vectors/blob/main/codes.json). By default it is lenient: a defect a receiver can safely work around is a `warning`, and the packet still decodes. A strict decoder rejects it instead, and the data is `unrecognized`.

```ts
import { decodeTnc2, formatDiagnostic, ParseOptions } from '@packet-net/pdn-aprs';

const line = 'N1EOE>APN391:!4216.95n/07243.20w#';

const lenient = decodeTnc2(line);
console.log(lenient.data.type); // position
console.log(lenient.diagnostics.map(formatDiagnostic).join(' ')); // warning:lowercase-hemisphere warning:lowercase-hemisphere

const strict = decodeTnc2(line, ParseOptions.strict);
console.log(strict.data.type); // unrecognized

const almostStrict = decodeTnc2(line, ParseOptions.strict.with('lowercase-hemisphere'));
console.log(almostStrict.data.type); // position
```

`ParseOptions.lenient.without(code)` tolerates everything but one code. A header that cannot be used at all throws `AprsHeaderError`, whose `diagnostics` say why.

## Building packets

`Aprs.from(...)` starts a packet; pick what it is, set what you need, and `build()` encodes it.

```ts
import { Aprs, Symbols } from '@packet-net/pdn-aprs';

const packet = Aprs.from('M0LTE-9')
  .via('WIDE1-1', 'WIDE2-1')
  .position(51.45, -0.98)
  .symbol(Symbols.car)
  .course(88)
  .speed(36)
  .comment('Mobile')
  .build();

console.log(packet.toTnc2()); // M0LTE-9>APZ001,WIDE1-1,WIDE2-1:!5127.00N/00058.80W>088/036Mobile
const frame = packet.toAx25(); // or toKiss() for a KISS TNC
console.log(frame.length); // 63
```

The destination defaults to `APZ001` in the experimental range; give your application's own with `.to(...)`. The builder covers what an application usually sends:

```ts
import { Aprs, Symbols } from '@packet-net/pdn-aprs';

const station = Aprs.from('M0LTE');

// A message wanting an ack, and the ack
console.log(station.message('G4ABC', 'Meet at the club at 8?').id(42).toTnc2()); // M0LTE>APZ001::G4ABC    :Meet at the club at 8?{42
console.log(station.ack('G4ABC', '7').toTnc2()); // M0LTE>APZ001::G4ABC    :ack7

// Status, with a locator and symbol
console.log(station.status('On the air').locator('IO91SX', Symbols.house).toTnc2()); // M0LTE>APZ001:>IO91SX/- On the air

// An object, with a timestamp (objects always have one; it defaults to now)
console.log(
  station
    .object('NET', 51.5, -0.1)
    .timestamp({ kind: 'dhm-zulu', day: 26, hour: 19, minute: 30 })
    .symbol(Symbols.redCross)
    .comment('Net control')
    .toTnc2(),
); // M0LTE>APZ001:;NET      *261930z5130.00N/00006.00W+Net control

// Weather at a position
console.log(
  station
    .weather(51.45, -0.98, { windDirectionDegrees: 220, windSpeedMph: 4, windGustMph: 5, temperatureF: 61, humidityPercent: 80, pressureMbar: 1013.2 })
    .toTnc2(),
); // M0LTE>APZ001:!5127.00N/00058.80W_220/004g005t061h80b10132

// Telemetry, and a Mic-E position (which computes its destination address)
console.log(station.telemetry(5, [199, 0, 255, 73, 123], '01101001').toTnc2()); // M0LTE>APZ001:T#005,199,000,255,073,123,01101001
console.log(station.micE(51.5, -0.1234).symbol(Symbols.car).micEMessage('en-route').speed(20).course(90).toTnc2()); // M0LTE>UQ3PPP:`v_Dn v>/`
```

Anything the spec does not allow is refused when you build it, with an `AprsEncodeError` saying why: message text over 67 characters, an object name with a trailing space, two data extensions at once. Free text is checked by decoding what was written, so a comment that would read back as something else (an altitude, a PHG code, a `!DAO!`) gets a `/` delimiter in front if that fixes it, and is refused if not.

```ts
import { Aprs, AprsEncodeError } from '@packet-net/pdn-aprs';

try {
  Aprs.from('M0LTE').position(51.45, -0.98).comment('at /A=001234').build();
} catch (e) {
  console.log(e instanceof AprsEncodeError); // true
}
```

The encoder also works on data directly: `encodeInformation(data)` returns the information field bytes (and for Mic-E the destination), and `encodeTnc2` / `encodeAx25` a whole packet. Decoding and encoding again round-trips: data from the decoder encodes back to the same bytes, or to bytes that decode to the same data, or is refused when there are none. It is never written as bytes that read back as different data, apart from wind or a range going back into a compressed position's cs bytes, which carry them in steps.

## Symbols

Every symbol the APRS symbol tables define is available by name, with its description. Symbols in the alternate table can carry an overlay character.

```ts
import { describeSymbol, Symbols, symbolName, withOverlay } from '@packet-net/pdn-aprs';

console.log(Symbols.car.table + Symbols.car.code); // />
console.log(describeSymbol(Symbols.digipeater)); // Digi (green star with white center)

const igate = withOverlay(Symbols.gateway, 'I');
console.log(igate.table + igate.code); // I&
console.log(symbolName(igate)); // gateway
```

## Device identification

`packet.device` identifies the sending device or software from the [APRS device identification database](https://github.com/aprsorg/aprs-deviceid): by the destination address, or for a Mic-E report by its type code and suffix. `identifyTocall` looks one up directly.

```ts
import { identifyTocall } from '@packet-net/pdn-aprs';

console.log(identifyTocall('APDW18')?.model); // DireWolf
```

## Conformance

The conformance vectors are a git submodule at `vectors/`. The test suite runs every case with every check the vectors' README defines (the lenient result, the strict result, the single-tolerance check, re-encoding, and the encode cases), one test per check per case: 5,942 tests, all passing. A check this implementation could not pass would be listed in `test/known-differences.json` with the reason and skipped; the list is empty.

`scripts/diff-dump.mjs` writes the differential dump that the vectors' `tools/compare.py` reads, for comparing implementations over a whole capture:

```sh
git submodule update --init
npm ci && npm run build
node scripts/diff-dump.mjs lines.hex.gz ts.jsonl.gz
python3 vectors/tools/compare.py ts.jsonl.gz other.jsonl.gz --names TS Other --lines lines.hex.gz
```

The examples in this README run as tests too (`test/readme.test.ts`).

## Licence

AGPL-3.0-or-later; see [LICENSE](LICENSE). The device identification data is from the APRS device identification database, CC BY-SA 2.0; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
