// @packet-net/pdn-aprs: an APRS encoder and decoder.

export * from './types.js';
export * from './codes.js';
export { ParseOptions, formatDiagnostic, type Diagnostic, type Severity } from './diagnostics.js';
export { AprsHeaderError, findQConstruct, formatPath, formatTnc2Header, isAprsIsAddress } from './header.js';
export { decodeTnc2, decodeAx25, decodeKiss, unwrapKiss } from './decoder.js';
export { decodeInformation, type DecodedInformation } from './decode/index.js';
export { identifyTocall, identifyMicE, DEVICEID_SOURCE, DEVICE_CLASSES } from './deviceid.js';
export { formatTimestamp, parseTimestamp } from './neutral.js';
export { hasErrors, hasWarnings, packetToTnc2, packetToTnc2Bytes, packetToAx25, phgValues, type PhgValues } from './packet.js';
export {
  AprsEncodeError,
  encodeInformation,
  encodeTnc2,
  encodeTnc2Bytes,
  encodeAx25,
  wrapKiss,
  type EncodedInformation,
  type PacketToEncode,
} from './encode/index.js';
export {
  Symbols,
  symbolOf,
  symbolText,
  symbolName,
  describeSymbol,
  withOverlay,
  withoutOverlay,
  overlayOf,
  acceptsOverlay,
  sameSymbol,
  type SymbolName,
} from './symbols.js';
export { Aprs, DEFAULT_DESTINATION, timestampOf, type BuiltPacket, type WeatherInput } from './builder.js';
// The builder classes are for naming types only: `Aprs.from()` is the way in.
export type {
  PacketBuilder,
  PositionBuilder,
  ObjectBuilder,
  ItemBuilder,
  MicEBuilder,
  MessageBuilder,
  StatusBuilder,
  TelemetryBuilder,
  DataBuilder,
} from './builder.js';
