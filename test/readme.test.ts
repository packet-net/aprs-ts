// Runs the TypeScript examples in README.md. Each `console.log(x); // expected` line checks that
// String(x) is the expected text; the rest of the example runs as written.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
const dir = fileURLToPath(new URL('./.readme/', import.meta.url));
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Turns `console.log(expr); // expected` (possibly spread over lines) into a check. */
function instrument(code: string): string {
  const src = code.replace(/from 'pdn-aprs'/g, "from '../../src/index.js'");
  const out: string[] = [];
  const lines = src.split('\n');
  let pending: string[] = [];
  for (const line of lines) {
    if (pending.length > 0 || /^\s*console\.log\(/.test(line)) {
      pending.push(line);
      const joined = pending.join('\n');
      const m = /^(\s*)console\.log\(([\s\S]*)\);\s*\/\/ (.*)$/.exec(joined);
      if (m) {
        out.push(`${m[1]}__check(${m[2]!.replace(/,\s*$/, '')}, ${JSON.stringify(m[3])});`);
        pending = [];
      } else if (/\);\s*$/.test(line)) {
        out.push(joined);
        pending = [];
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

describe('README examples', () => {
  blocks.forEach((code, i) => {
    it(`example ${i + 1}`, async () => {
      const checks: [unknown, string][] = [];
      (globalThis as Record<string, unknown>).__check = (value: unknown, expected: string) => checks.push([value, expected]);
      const file = `${dir}example${i + 1}.ts`;
      writeFileSync(file, `declare const __check: (v: unknown, e: string) => void;\n${instrument(code)}\n`);
      await import(/* @vite-ignore */ file);
      expect(checks.length).toBeGreaterThan(0);
      for (const [value, expected] of checks) expect(String(value)).toBe(expected);
    });
  });
});
