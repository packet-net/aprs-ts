// Messages, acks and rejects, bulletins, telemetry metadata and directed queries (APRS12c ch.
// 13-15).

import type { AprsData } from '../types.js';
import type { DecodeContext } from './context.js';

/** Known directed query types (APRS12c ch. 15), longest first. */
export const DIRECTED_QUERY_TYPES: readonly string[] = ['APRSD', 'APRSH', 'APRSM', 'APRSO', 'APRSP', 'APRSS', 'APRST', 'PING?'];

const MESSAGE_ID_RE = /^([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?$/;
const PLAIN_ID_RE = /^([A-Za-z0-9]{1,5})$/;
// ack or rej, the ID, an optional reply-ack, and an optional message ID of its own.
const ACK_RE = /^(ack|rej)([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?(\{[A-Za-z0-9]{1,5})?$/;
// A number: an optional -, digits with an optional point, and for a coefficient an exponent.
const COEFFICIENT_RE = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const METADATA_PREFIXES = ['PARM.', 'UNIT.', 'EQNS.', 'BITS.'];

interface SplitText {
  text: string;
  messageId?: string;
  replyAck?: string;
  /** A `{` that does not start a message ID (`brace-in-message-text`). */
  strayBrace: boolean;
}

/**
 * Splits `text{id}ack` into its parts. Bulletins and telemetry metadata are not acknowledged, so
 * for them (`replyAcks` false) the reply-ack form is not an ID and stays in the text (vectors
 * interpretations.md, "Reply-acks are for messages").
 */
function splitMessageId(text: string, replyAcks: boolean): SplitText {
  const brace = text.lastIndexOf('{');
  if (brace < 0) return { text, strayBrace: false };
  const m = (replyAcks ? MESSAGE_ID_RE : PLAIN_ID_RE).exec(text.slice(brace + 1));
  if (!m) return { text, strayBrace: true };
  const out: SplitText = { text: text.slice(0, brace), messageId: m[1]!, strayBrace: false };
  if (m[2] !== undefined) out.replyAck = m[2];
  if (out.text.includes('{')) out.strayBrace = true;
  return out;
}

function parseList(body: string): string[] {
  return body.split(',');
}

/** `:`: a message, or one of the things sent in message form. */
export function decodeMessage(ctx: DecodeContext, s: string): AprsData {
  // When the tenth byte is :, the addressee is the nine bytes before it, whatever they hold.
  let colon = -1;
  if (s.length > 10 && s[10] === ':') {
    colon = 10;
  } else {
    if (s[1] === ':') ctx.fail('invalid-message');
    for (let k = 2; k <= 9 && k < s.length; k++) {
      if (s[k] === ':') {
        colon = k;
        break;
      }
    }
    if (colon < 0) ctx.fail('invalid-message');
    ctx.tolerate('unpadded-addressee');
  }
  const addressee = s.slice(1, colon).replace(/ +$/, '');
  if (addressee.length === 0 || !/^[\x20-\x7e]+$/.test(addressee)) ctx.fail('invalid-message');
  if (/[ :]/.test(addressee)) ctx.tolerate('invalid-addressee-characters');
  const body = s.slice(colon + 1);

  // Acks and rejects.
  const ack = ACK_RE.exec(body);
  if (ack) {
    if (ack[4] !== undefined) ctx.tolerate('message-id-on-ack');
    const replyAck = ack[3];
    if (ack[1] === 'ack') {
      return replyAck === undefined
        ? { type: 'ack', addressee, ackedId: ack[2]! }
        : { type: 'ack', addressee, ackedId: ack[2]!, replyAck };
    }
    return replyAck === undefined
      ? { type: 'reject', addressee, rejectedId: ack[2]! }
      : { type: 'reject', addressee, rejectedId: ack[2]!, replyAck };
  }

  // Bulletins and announcements.
  if (/^BLN[0-9]/.test(addressee) || /^BLN[A-Z]$/.test(addressee) || /^BLN[A-Z]./.test(addressee)) {
    if (/^BLN[A-Z]./.test(addressee)) ctx.tolerate('letter-group-bulletin');
    const split = splitMessageId(body, false);
    if (split.strayBrace) ctx.tolerate('brace-in-message-text');
    const text = ctx.text(split.text);
    return withId({ type: 'bulletin' as const, addressee, text }, split.messageId);
  }
  if (/^NWS[-_]/.test(addressee)) {
    const split = splitMessageId(body, false);
    if (split.strayBrace) ctx.tolerate('brace-in-message-text');
    const text = ctx.text(split.text);
    return withId({ type: 'nws-bulletin' as const, addressee, text }, split.messageId);
  }

  // Directed queries.
  if (body.startsWith('?')) {
    const query = directedQuery(ctx, addressee, body);
    if (query) return query;
  }

  // Telemetry metadata: its structure is checked before the text's encoding.
  if (METADATA_PREFIXES.includes(body.slice(0, 5))) {
    const meta = telemetryMetadata(ctx, addressee, body);
    if (meta) return meta;
  }

  const split = splitMessageId(body, true);
  if (split.strayBrace) ctx.tolerate('brace-in-message-text');
  const text = ctx.text(split.text);
  const message: { type: 'message'; addressee: string; text: string; messageId?: string; replyAck?: string } = {
    type: 'message',
    addressee,
    text,
  };
  if (split.messageId !== undefined) message.messageId = split.messageId;
  if (split.replyAck !== undefined) message.replyAck = split.replyAck;
  return message;
}

function withId<T extends object>(data: T, messageId: string | undefined): T {
  return messageId === undefined ? data : { ...data, messageId };
}

function directedQuery(ctx: DecodeContext, addressee: string, body: string): AprsData | undefined {
  const q = body.slice(1);
  if (q.includes('{')) {
    ctx.info('invalid-query');
    return undefined;
  }
  const known = DIRECTED_QUERY_TYPES.find((t) => q.startsWith(t));
  const knownLower = DIRECTED_QUERY_TYPES.find((t) => q.toUpperCase().startsWith(t));
  let queryType: string | undefined;
  let rest = '';
  if (known) {
    queryType = known;
    rest = q.slice(known.length);
  } else if (knownLower) {
    ctx.info('invalid-query');
    return undefined;
  } else {
    const m = /^([A-Z]+)(?= |$)/.exec(q);
    if (!m) return undefined;
    queryType = m[1]!;
    rest = q.slice(queryType.length);
  }
  // One space between the type and the target is a separator, and spaces after the target are
  // padding (APRSH pads its target to 9 characters).
  if (rest.startsWith(' ')) rest = rest.slice(1);
  const target = rest.replace(/ +$/, '');
  if (target.length === 0) return { type: 'directed-query', addressee, queryType };
  if (/^[A-Za-z0-9-]{1,9}$/.test(target)) return { type: 'directed-query', addressee, queryType, target };
  ctx.info('invalid-query');
  return undefined;
}

/** Telemetry metadata sent as a message; `body` is the text's bytes, decoded once it is valid. */
function telemetryMetadata(ctx: DecodeContext, addressee: string, body: string): AprsData | undefined {
  // Metadata takes a message ID, but not the reply-ack form.
  const split = splitMessageId(body, false);
  const binary = split.text;
  const messageId = split.messageId;
  const kind = binary.slice(0, 5);
  const rawBody = binary.slice(5);
  const invalid = (): undefined => {
    ctx.info('invalid-telemetry-metadata');
    return undefined;
  };
  const braces = (): void => {
    if (split.strayBrace) ctx.tolerate('brace-in-message-text');
  };
  if (kind === 'PARM.' || kind === 'UNIT.') {
    if (parseList(rawBody).length > 13) return invalid();
    braces();
    const list = parseList(ctx.text(rawBody));
    return kind === 'PARM.'
      ? withId({ type: 'telemetry-names' as const, addressee, names: list }, messageId)
      : withId({ type: 'telemetry-units' as const, addressee, units: list }, messageId);
  }
  if (kind === 'EQNS.') {
    const list = parseList(rawBody);
    // Trailing empty entries (commas and spaces) are the list stopping.
    while (list.length > 0 && /^ *$/.test(list[list.length - 1]!)) list.pop();
    if (list.length === 0 || list.length > 15) return invalid();
    const texts: string[] = [];
    for (const item of list) {
      // Spaces (U+0020 only) around a coefficient are padding (vectors interpretations.md,
      // "Numbers in telemetry").
      const t = item.replace(/^ +| +$/g, '');
      if (!COEFFICIENT_RE.test(t) || !Number.isFinite(Number(t))) return invalid();
      texts.push(t);
    }
    braces();
    return withId(
      { type: 'telemetry-coefficients' as const, addressee, coefficients: texts.map(Number), coefficientsText: texts },
      messageId,
    );
  }
  const m = /^([01]{8})(?:,(.*))?$/s.exec(rawBody);
  if (!m) return invalid();
  braces();
  const bits: { type: 'telemetry-bits'; addressee: string; bits: string; project?: string } = {
    type: 'telemetry-bits',
    addressee,
    bits: m[1]!,
  };
  if (m[2] !== undefined && m[2].length > 0) bits.project = ctx.text(m[2]);
  return withId(bits, messageId);
}
