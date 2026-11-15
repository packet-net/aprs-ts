export interface RecipeLibrary {
  Aprs: unknown;
  AprsEncodeError: new (...args: never[]) => Error & { code: string };
  refusalRank: (code: never) => number;
}

/** The packet a builder made, as far as the tools use it: written as a frame. */
export interface RecipePacket {
  toAx25(): Uint8Array;
  toTnc2Bytes(): Uint8Array;
}

export type RecipeResult =
  | { n: number; result: 'built'; bytes: Uint8Array; packet: RecipePacket }
  | { n: number; result: 'refused'; reason: string; refusal: string; packet?: RecipePacket; via?: 'tool' }
  | { n: number; result: 'unsupported'; reason: string };

export function recipeBuilder(lib: RecipeLibrary): {
  /** `write` is the form the packet is written in: a TNC2 line (the default) or an AX.25 frame. */
  buildRecipe(n: number, recipe: { station: Record<string, unknown>; report: string; args?: Record<string, unknown> }, write?: 'tnc2' | 'ax25'): RecipeResult;
};
