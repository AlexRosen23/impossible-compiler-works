import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSource } from '../src/core/model/compile.ts';
import { check } from '../src/core/engine/check.ts';
import type { Bounds } from '../src/core/engine/explore.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const example = (slug: string) => readFileSync(path.join(ROOT, 'examples', `${slug}.witness`), 'utf8');

export function compileOk(src: string) {
  const c = compileSource(src);
  if (!c.ok) throw new Error(`does not compile: ${c.diagnostics.map((d) => d.message).join('; ')}`);
  return c.model!;
}

export function run(src: string, bounds?: Partial<Bounds>) {
  return check(compileOk(src), { bounds, includeGraph: true });
}

export const prop = (r: ReturnType<typeof run>['result'], name: string) => {
  const p = r.properties.find((x) => x.name === name);
  if (!p) throw new Error(`no property ${name}`);
  return p;
};
