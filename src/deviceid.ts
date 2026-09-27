// Device identification from the APRS device identification database
// (https://github.com/aprsorg/aprs-deviceid): by destination (tocall), or for a Mic-E report by
// its type code and suffix.

import { MICE, MICE_LEGACY, TOCALLS, type DeviceEntry } from './deviceid-data.js';
import type { DeviceInfo } from './types.js';

export { DEVICEID_SOURCE, DEVICE_CLASSES } from './deviceid-data.js';

function toInfo(entry: DeviceEntry): DeviceInfo {
  const out: { -readonly [K in keyof DeviceInfo]: DeviceInfo[K] } = {};
  if (entry.vendor !== undefined) out.vendor = entry.vendor;
  if (entry.model !== undefined) out.model = entry.model;
  if (entry.class !== undefined) out.class = entry.class;
  if (entry.os !== undefined) out.os = entry.os;
  if (entry.features !== undefined) out.features = entry.features;
  return out;
}

interface CompiledTocall {
  regex: RegExp;
  fixed: number;
  length: number;
  entry: DeviceEntry;
}

let compiled: CompiledTocall[] | undefined;

function compile(): CompiledTocall[] {
  if (compiled) return compiled;
  compiled = TOCALLS.map((t) => {
    let re = '';
    let fixed = 0;
    for (const c of t.tocall) {
      if (c === '?') re += '.';
      else if (c === '*') re += '.*';
      else if (c === 'n') re += '[0-9]';
      else {
        re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        fixed++;
      }
    }
    return { regex: new RegExp(`^${re}$`), fixed, length: t.tocall.length, entry: t };
  });
  // Most specific first: more fixed characters, then longer patterns.
  compiled.sort((a, b) => b.fixed - a.fixed || b.length - a.length);
  return compiled;
}

// Destinations repeat constantly (a handful of tocalls cover most traffic), and matching one means
// trying up to every pattern in the database, so answers are remembered. The cache is bounded so a
// stream of junk destinations cannot grow it without limit.
const tocallCache = new Map<string, DeviceInfo | undefined>();
const TOCALL_CACHE_LIMIT = 4096;

/** The device a destination address (tocall) identifies, e.g. `APDW18` is Dire Wolf. */
export function identifyTocall(destination: string): DeviceInfo | undefined {
  const call = destination.split('-')[0]!.toUpperCase();
  if (tocallCache.has(call)) return tocallCache.get(call);
  let found: DeviceInfo | undefined;
  for (const t of compile()) {
    if (t.regex.test(call)) {
      found = Object.freeze(toInfo(t.entry));
      break;
    }
  }
  if (tocallCache.size >= TOCALL_CACHE_LIMIT) tocallCache.clear();
  tocallCache.set(call, found);
  return found;
}

/**
 * The device suffix at the end of Mic-E status text, if the database knows one for this type
 * code: a two-character suffix after `` ` `` or `'`, a one-character Kenwood suffix after `>` or `]`.
 */
export function findMicESuffix(typeCode: string, text: string): string | undefined {
  if (typeCode === '`' || typeCode === "'") {
    for (const m of MICE) if (text.endsWith(m.suffix)) return m.suffix;
  } else if (typeCode === '>' || typeCode === ']') {
    for (const m of MICE_LEGACY) if (m.prefix === typeCode && m.suffix !== undefined && text.endsWith(m.suffix)) return m.suffix;
  }
  return undefined;
}

/** The device a Mic-E type code and suffix identify. */
export function identifyMicE(typeCode: string | undefined, suffix: string | undefined): DeviceInfo | undefined {
  if (typeCode === undefined) return undefined;
  if (typeCode === '`' || typeCode === "'") {
    if (suffix === undefined) return undefined;
    const m = MICE.find((e) => e.suffix === suffix);
    return m ? toInfo(m) : undefined;
  }
  if (typeCode === '>' || typeCode === ']') {
    const m = MICE_LEGACY.find((e) => e.prefix === typeCode && e.suffix === suffix);
    return m ? toInfo(m) : undefined;
  }
  return undefined;
}
