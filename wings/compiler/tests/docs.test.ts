// Keeps the written specification aligned with the executable one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTINS, DIAGNOSTIC_CODES, FAULT_CODES, PRIMITIVES } from '../core/index.ts';
import { ROOT } from './helpers.ts';

const doc = (f: string) => readFileSync(join(ROOT, 'docs', f), 'utf8');

describe('documentation matches the implementation', () => {
  it('TYPE_SYSTEM.md has a table row for every diagnostic code', () => {
    const t = doc('TYPE_SYSTEM.md');
    const missing = Object.keys(DIAGNOSTIC_CODES).filter((c) => !new RegExp(`^\\|\\s*\`?${c}\`?\\s*\\|`, 'm').test(t));
    expect(missing).toEqual([]);
  });
  it('the language spec names every runtime fault, built-in and primitive', () => {
    const s = doc('FOLIO_LANGUAGE_SPEC.md');
    for (const c of Object.keys(FAULT_CODES)) expect(s, c).toContain(c);
    for (const b of Object.keys(BUILTINS)) expect(s, b).toContain(`${b}(`);
    for (const p of Object.keys(PRIMITIVES)) expect(s, p).toContain(p);
  });
});
