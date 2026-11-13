import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureTable } from '../core/index.ts';

import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function loadExampleFixtures(): FixtureTable {
  const dir = join(ROOT, 'examples', 'fixtures');
  const out: FixtureTable = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}
export function gitCommit(): string | null {
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    return readFileSync(join(ROOT, '.git', head.slice(5)), 'utf8').trim();
  } catch { return null; }
}
