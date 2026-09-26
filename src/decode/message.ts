// Messages, acks and rejects, bulletins, telemetry metadata and directed queries (APRS12c ch.
// 13-15).

import type { AprsData } from '../types.js';
import type { DecodeContext } from './context.js';

/** Known directed query types (APRS12c ch. 15), longest first. */
const DIRECTED_QUERY_TYPES = ['APRSD', 'APRSH', 'APRSM', 'APRSO', 'APRSP', 'APRSS', 'APRST', 'PING?'];

const MESSAGE_ID_RE = /^([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?$/;
const ACK_RE = /^(ack|rej)([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?(\{.*)?$/;
const COEFFICIENT_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

interface SplitText {
  text: string;
  messageId?: string;
  replyAck?: string;
}

/** Splits `text{id}ack` into its parts; reports a brace that does not start an ID. */
function splitMessageId(ctx: DecodeContext, text: string): SplitText {
  const brace = text.lastIndexOf('{');
  if (brace < 0) return { text };
  const m = MESSAGE_ID_RE.exec(text.slice(brace + 1));
  if (!m) {
    ctx.tolerate('brace-in-message-text');
    return { text };
  }
  const out: SplitText = { text: text.slice(0, brace), messageId: m[1]! };
  if (m[2] !== undefined) out.replyAck = m[2];
  if (out.text.includes('{')) ctx.tolerate('brace-in-message-text');
  return out;
}

function parseList(body: string): string[] {
  return body.split(',');
}

/** `:`: a message, or one of the things sent in message form. */
export function decodeMessage(ctx: DecodeContext, s: string): AprsData {
  if (s[1] === ':') ctx.fail('invalid-message');
  let colon = -1;
  if (s.length > 10 && s[10] === ':') {
    colon = 10;
  } else {
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
    const split = splitMessageId(ctx, body);
    const text = ctx.text(split.text);
    return withId({ type: 'bulletin' as const, addressee, text }, split.messageId);
  }
  if (/^NWS[-_]/.test(addressee)) {
    const split = splitMessageId(ctx, body);
    const text = ctx.text(split.text);
    return withId({ type: 'nws-bulletin' as const, addressee, text }, split.messageId);
  }

  // Directed queries.
  if (body.startsWith('?')) {
    const query = directedQuery(ctx, addressee, body);
    if (query) return query;
  }

  const split = splitMessageId(ctx, body);
  const text = ctx.text(split.text);

  // Telemetry metadata.
  const meta = telemetryMetadata(ctx, addressee, text, split.messageId);
  if (meta) return meta;

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
  if (rest.includes('{')) {
    ctx.info('invalid-query');
    return undefined;
  }
  const target = rest.trim();
  if (target.length === 0) return { type: 'directed-query', addressee, queryType };
  if (/^[A-Za-z0-9-]{1,9}$/.test(target)) return { type: 'directed-query', addressee, queryType, target };
  ctx.info('invalid-query');
  return undefined;
}

function telemetryMetadata(
  ctx: DecodeContext,
  addressee: string,
  text: string,
  messageId: string | undefined,
): AprsData | undefined {
  const kind = text.slice(0, 5);
  if (kind !== 'PARM.' && kind !== 'UNIT.' && kind !== 'EQNS.' && kind !== 'BITS.') return undefined;
  const body = text.slice(5);
  const invalid = (): undefined => {
    ctx.info('invalid-telemetry-metadata');
    return undefined;
  };
  if (kind === 'PARM.' || kind === 'UNIT.') {
    const list = parseList(body);
    if (list.length > 13) return invalid();
    return kind === 'PARM.'
      ? withId({ type: 'telemetry-names' as const, addressee, names: list }, messageId)
      : withId({ type: 'telemetry-units' as const, addressee, units: list }, messageId);
  }
  if (kind === 'EQNS.') {
    const list = parseList(body);
    // Trailing empty entries (commas and spaces) are the list stopping.
    while (list.length > 0 && list[list.length - 1]!.trim() === '') list.pop();
    if (list.length === 0 || list.length > 15) return invalid();
    const texts: string[] = [];
    for (const item of list) {
      const t = item.trim();
      if (!COEFFICIENT_RE.test(t)) return invalid();
      texts.push(t);
    }
    return withId(
      { type: 'telemetry-coefficients' as const, addressee, coefficients: texts.map(Number), coefficientsText: texts },
      messageId,
    );
  }
  const m = /^([01]{8})(?:,(.*))?$/s.exec(body);
  if (!m) return invalid();
  const bits: { type: 'telemetry-bits'; addressee: string; bits: string; project?: string } = {
    type: 'telemetry-bits',
    addressee,
    bits: m[1]!,
  };
  if (m[2] !== undefined && m[2].length > 0) bits.project = m[2];
  return withId(bits, messageId);
}
