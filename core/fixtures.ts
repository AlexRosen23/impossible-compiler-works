// Project-declared, read-only datasets. A program names a fixture ("rainfall"); the host passes the fixture
// table in. There is no path syntax and no fetch: a fixture name is an identifier, never a file system path.
import type { CheckResult } from './checker.ts';
import { listElem } from './checker.ts';
import type { Diagnostic } from './diagnostics.ts';
import type { Limits } from './limits.ts';
import { type Value, colorFromHex, point } from './values.ts';

export type FixtureTable = Record<string, unknown>;
export const FIXTURE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export interface FixtureResult { values: Map<string, Value>; diagnostics: Diagnostic[] }

export function loadFixtures(check: CheckResult, table: FixtureTable, limits: Limits): FixtureResult {
  const values = new Map<string, Value>();
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, node: number) => {
    const span = check.symbols.find((s) => s.declNode === node)?.declSpan ?? { start: 0, end: 0, line: 1, col: 1 };
    diagnostics.push({ code, severity: 'error', message, span, stage: 'fixture' });
  };
  for (const d of check.data) {
    if (!FIXTURE_NAME.test(d.fixture)) { err('F003', `"${d.fixture}" is not a fixture name (lowercase letters, digits, - and _; no paths)`, d.node); continue; }
    if (!Object.prototype.hasOwnProperty.call(table, d.fixture)) { err('F001', `no fixture named "${d.fixture}" in this project`, d.node); continue; }
    const raw = table[d.fixture];
    const elem = listElem(d.type);
    if (!Array.isArray(raw)) { err('F002', `fixture "${d.fixture}" is not a list`, d.node); continue; }
    if (raw.length > limits.maxFixtureLength) { err('F004', `fixture "${d.fixture}" has ${raw.length} items; the limit is ${limits.maxFixtureLength}`, d.node); continue; }
    const out: Value[] = [];
    let bad: string | null = null;
    raw.forEach((x, i) => {
      if (bad) return;
      if (elem === 'Number' && typeof x === 'number' && Number.isFinite(x)) out.push(x);
      else if (elem === 'String' && typeof x === 'string' && x.length <= limits.maxStringLength) out.push(x);
      else if (elem === 'Boolean' && typeof x === 'boolean') out.push(x);
      else if (elem === 'Color' && typeof x === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(x)) out.push(colorFromHex(x));
      else if (elem === 'Point' && Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === 'number' && Number.isFinite(v))) out.push(point(x[0], x[1]));
      else bad = `item ${i} (${JSON.stringify(x)?.slice(0, 40)}) is not a ${elem}`;
    });
    if (bad) { err('F002', `fixture "${d.fixture}" does not match ${d.type}: ${bad}`, d.node); continue; }
    values.set(d.name, Object.freeze(out));
  }
  return { values, diagnostics };
}
