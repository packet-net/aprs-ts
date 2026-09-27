// Byte and text helpers. APRS parsing works on a "binary string", one character per byte
// (U+0000-U+00FF), so fixed-width fields line up with the bytes sent; text fields are then
// decoded from their bytes as UTF-8, or as Latin-1 when they are not valid UTF-8.

/** One character per byte. */
export function bytesToBinary(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = start; i < end; i += CHUNK) {
    // apply takes the typed array directly; copying it into an Array first doubled the cost.
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CHUNK)) as unknown as number[]);
  }
  return s;
}

/** The bytes of a binary string (each character must be U+0000-U+00FF). */
export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Whether a binary string is all ASCII. */
export function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Decodes a binary string as UTF-8; `undefined` if it is not valid UTF-8. */
export function decodeUtf8Binary(s: string): string | undefined {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const b0 = s.charCodeAt(i);
    if (b0 < 0x80) {
      // Copy a run of ASCII at once.
      let j = i + 1;
      while (j < n && s.charCodeAt(j) < 0x80) j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    let cp: number;
    let need: number;
    let min: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      need = 1;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      need = 2;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      need = 3;
      min = 0x10000;
    } else {
      return undefined;
    }
    if (i + need >= n) return undefined;
    for (let k = 1; k <= need; k++) {
      const b = s.charCodeAt(i + k);
      if ((b & 0xc0) !== 0x80) return undefined;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** Decodes bytes as UTF-8; `undefined` if they are not valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  return decodeUtf8Binary(bytesToBinary(bytes));
}

/** Encodes a string as UTF-8, as a binary string. */
export function encodeUtf8Binary(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out += ch;
    else if (cp < 0x800) out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out += String.fromCharCode(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return out;
}

/** Encodes a string as UTF-8. */
export function encodeUtf8(text: string): Uint8Array {
  return binaryToBytes(encodeUtf8Binary(text));
}

/** Parses hex (whitespace allowed) into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new RangeError('not hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Formats bytes as upper-case hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).toUpperCase().padStart(2, '0');
  return s;
}
