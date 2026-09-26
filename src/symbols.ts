// Symbols by name, and overlays. `Symbols.car` is `/>`; `withOverlay(Symbols.gateway, 'I')` is an
// IGate (`I&`).

import { NAMED_SYMBOLS, OVERLAY_CODES } from './symbols-data.js';
import type { AprsSymbol } from './types.js';

/** The name of every symbol the APRS symbol tables define. */
export type SymbolName = keyof typeof NAMED_SYMBOLS;

function freeze(table: string, code: string): AprsSymbol {
  return Object.freeze({ table, code });
}

/**
 * Every symbol the APRS symbol tables define (APRS12c ch. 21), by name: `Symbols.car`,
 * `Symbols.house`, `Symbols.weatherStation`, `Symbols.digipeater`, ...
 */
export const Symbols: { readonly [K in SymbolName]: AprsSymbol } = Object.freeze(
  Object.fromEntries(Object.entries(NAMED_SYMBOLS).map(([name, s]) => [name, freeze(s.table, s.code)])),
) as { readonly [K in SymbolName]: AprsSymbol };

const byText = new Map<string, SymbolName>();
for (const [name, s] of Object.entries(NAMED_SYMBOLS)) byText.set(s.table + s.code, name as SymbolName);

function isOverlayChar(c: string): boolean {
  return c.length === 1 && ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'));
}

/** A symbol from its two characters, table then code: `symbolOf('/>')`. */
export function symbolOf(text: string): AprsSymbol {
  if (text.length !== 2) throw new RangeError('a symbol is two characters: the table (or overlay), then the code');
  return freeze(text[0]!, text[1]!);
}

/** A symbol's two characters, table then code. */
export function symbolText(symbol: AprsSymbol): string {
  return symbol.table + symbol.code;
}

/** The overlay character on a symbol, if it has one (a table of `0`-`9` or `A`-`Z`). */
export function overlayOf(symbol: AprsSymbol): string | undefined {
  return isOverlayChar(symbol.table) ? symbol.table : undefined;
}

/** A symbol without its overlay: an overlaid symbol is an alternate-table (`\`) symbol. */
export function withoutOverlay(symbol: AprsSymbol): AprsSymbol {
  return isOverlayChar(symbol.table) ? freeze('\\', symbol.code) : symbol;
}

/** Whether the symbol tables mark this alternate-table symbol as taking an overlay. */
export function acceptsOverlay(symbol: AprsSymbol): boolean {
  const base = withoutOverlay(symbol);
  return base.table === '\\' && OVERLAY_CODES.includes(base.code);
}

/**
 * An alternate-table symbol with an overlay character (`0`-`9` or `A`-`Z`):
 * `withOverlay(Symbols.gateway, 'I')` is `I&`. Throws for a primary-table symbol, an overlay
 * character that is not a digit or capital letter, or a symbol the tables do not mark as taking
 * an overlay.
 */
export function withOverlay(symbol: AprsSymbol, overlay: string): AprsSymbol {
  if (!isOverlayChar(overlay)) throw new RangeError('an overlay is one digit or capital letter');
  const base = withoutOverlay(symbol);
  if (base.table !== '\\') throw new RangeError('only alternate-table (\\) symbols take an overlay');
  if (!OVERLAY_CODES.includes(base.code)) throw new RangeError(`the symbol tables do not mark \\${base.code} as taking an overlay`);
  return freeze(overlay, base.code);
}

/** A symbol's name, e.g. `car`; an overlaid symbol has its alternate-table symbol's name. */
export function symbolName(symbol: AprsSymbol): SymbolName | undefined {
  const base = withoutOverlay(symbol);
  return byText.get(base.table + base.code);
}

/** What a symbol shows, from the symbol table, e.g. `Car`. */
export function describeSymbol(symbol: AprsSymbol): string | undefined {
  const name = symbolName(symbol);
  return name === undefined ? undefined : NAMED_SYMBOLS[name].description;
}

/** Whether two symbols are the same. */
export function sameSymbol(a: AprsSymbol, b: AprsSymbol): boolean {
  return a.table === b.table && a.code === b.code;
}
