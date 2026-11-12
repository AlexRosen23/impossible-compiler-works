import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FixtureTable, type PassName, compile, interpret, runVM, sceneHash } from '../core/index.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function fixtures(): FixtureTable {
  const dir = join(ROOT, 'examples', 'fixtures');
  const out: FixtureTable = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}
export function examples(): { name: string; source: string }[] {
  const dir = join(ROOT, 'examples');
  return readdirSync(dir).filter((f) => /^\d\d-.*\.folio$/.test(f)).sort().map((f) => ({ name: f, source: readFileSync(join(dir, f), 'utf8') }));
}
export function failures(): { name: string; source: string; expect: { kind: 'compile' | 'fault'; code: string; line: number; col: number } }[] {
  const dir = join(ROOT, 'examples', 'failures');
  return readdirSync(dir).filter((f) => f.endsWith('.folio')).sort().map((f) => {
    const source = readFileSync(join(dir, f), 'utf8');
    const m = /^\/\/ expect(-fault)?: ([A-Z]\d{3}) @ (\d+):(\d+)/.exec(source)!;
    return { name: f, source, expect: { kind: m[1] ? 'fault' : 'compile', code: m[2], line: Number(m[3]), col: Number(m[4]) } };
  });
}

/** Observable outcome of a run: scene hash + fault code + fault source offset. */
export function outcome(r: { scene: Parameters<typeof sceneHash>[0]; fault: { code: string; span: { start: number } | null; frame: number } | null }) {
  return { scene: sceneHash(r.scene), fault: r.fault ? `${r.fault.code}@${r.fault.span?.start}#${r.fault.frame}` : null };
}

export function differential(source: string, passes: PassName[], fx: FixtureTable = fixtures()) {
  const c = compile(source, { passes, fixtures: fx });
  if (!c.ok) return { ok: false as const, diagnostics: c.diagnostics };
  const vm = runVM(c.bytecode!, c.data, c.limits);
  const ref = interpret(c.program!, c.check!, c.data, c.limits);
  return { ok: true as const, vm: outcome(vm), ref: outcome(ref), compiled: c };
}
