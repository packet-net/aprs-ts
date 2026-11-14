export interface RecipeLibrary {
  Aprs: unknown;
  AprsEncodeError: new (...args: never[]) => Error & { code: string };
  refusalRank: (code: never) => number;
}

export type RecipeResult =
  | { n: number; result: 'built'; bytes: Uint8Array }
  | { n: number; result: 'refused'; reason: string; refusal: string }
  | { n: number; result: 'unsupported'; reason: string };

export function recipeBuilder(lib: RecipeLibrary): {
  buildRecipe(n: number, recipe: { station: Record<string, unknown>; report: string; args?: Record<string, unknown> }): RecipeResult;
};
