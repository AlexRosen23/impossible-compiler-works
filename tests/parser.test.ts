import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/core/model/compile.ts';
import { parseModel, parseExpression } from '../src/core/syntax/parser.ts';
import { printModel } from '../src/core/syntax/print.ts';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.ts';

const err = (src: string) => {
  const r = compileSource(src);
  assert.equal(r.ok, false, 'expected a diagnostic');
  return r.diagnostics.find((d) => d.severity === 'error')!;
};

test('syntax errors carry a code, a message and a source position', () => {
  const d = err('model m\nvar x : 0..2 = 0\nprocess P {\n  action a when x < 2 { x = x + 1 }\n}\n');
  assert.equal(d.code, 'E100');
  assert.match(d.message, /Use ':=' for assignment/);
  assert.equal(d.span?.line, 4);
});

test('unknown names, type errors and misspelled literals are rejected', () => {
  assert.match(err('model m\nvar x : 0..2 = 0\ninvariant I: y = 0').message, /Unknown name 'y'/);
  assert.match(err('model m\nvar x : 0..2 = 0\ninvariant I: x').message, /must be a boolean/);
  assert.match(err('model m\nvar b : bool = false\ninvariant I: b + 1 = 2').message, /integer operands/);
  assert.match(err('model m\nprocess P { var pc : {idle, busy} = idle\n action a when pc = bussy { pc := busy } }').message, /Unknown name 'bussy'|never be equal/);
  assert.match(err('type T = {a}').message, /Expected 'model'/);
});

test('each variable may be assigned at most once per action', () => {
  assert.match(err('model m\nvar x : 0..2 = 0\nprocess P { action a { x := 1; x := 2 } }').message, /assigned twice/);
});

test('bounds and resource limits are enforced at compile time', () => {
  assert.match(err('model m\nvar x : 0..5000000 = 0').message, /more than 1000000 values/);
  assert.match(err('model m\nvar x : 3..1 = 3').message, /Empty range/);
  assert.match(err('model m\nvar x : 0..2 = 5').message, /outside its domain/);
  const huge = 'model m\n' + Array.from({ length: 70 }, (_, i) => `var v${i} : bool = false`).join('\n');
  assert.match(err(huge).message, /At most 64 state variables/);
  const big = 'model m\n// ' + 'x'.repeat(70 * 1024);
  assert.match(err(big).message, /exceeds 65536 bytes/);
  assert.match(err('model m\nvar x : 0..1234567890 = 0').message, /too large|more than/);
});

test('no host-language code can be smuggled in: calls, strings and unknown characters are refused', () => {
  assert.match(err('model m\nvar x : 0..2 = 0\ninvariant I: require("fs") = 1').message, /Function calls are not part/);
  assert.match(err('model m\nvar x : 0..2 = 0\ninvariant I: x = "1"').message, /Strings are only allowed/);
  assert.match(err('model m\nvar x : 0..2 = `1`').message, /Unexpected character/);
  assert.match(err('model m\nvar x : 0..2 = 0\nconstructor x').message, /Unexpected/);
});

test('unsupported temporal operators are refused, not approximated', () => {
  assert.match(err('model m\nvar x : bool = false\nliveness L: always x').message, /Unknown name 'always'|Unsupported liveness form/);
  assert.match(err('model m\nvar x : bool = false\nliveness L: x').message, /Unsupported liveness form/);
});

test('self, qualified locals and process templates resolve correctly', () => {
  const r = compileSource('model m\ntype O = {nobody, A, B}\nvar owner : O = nobody\nprocess A, B {\n var pc : {idle, done} = idle\n action take when owner = nobody and pc = idle { owner := self; pc := done }\n}\ninvariant I: not (A.pc = done and B.pc = done)');
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.model!.vars.map((v) => v.name), ['owner', 'A.pc', 'B.pc']);
  assert.deepEqual(r.model!.actions.map((a) => a.label), ['A.take', 'B.take']);
});

test('self must fit the target type', () => {
  assert.match(err('model m\ntype O = {nobody, A}\nvar owner : O = nobody\nprocess A, B { action t { owner := self } }').message, /'B' is not a value of type O/);
});

test('parameterised actions instantiate once per value', () => {
  const r = compileSource('model m\nvar x : 0..3 = 0\nprocess P { action set(v in 1..3) when x = 0 { x := v } }');
  assert.ok(r.ok);
  assert.deepEqual(r.model!.actions.map((a) => a.label), ['P.set(v=1)', 'P.set(v=2)', 'P.set(v=3)']);
});

test('comparison chains are rejected and precedence is conventional', () => {
  assert.throws(() => parseExpression('1 < x < 3'), /cannot be chained/);
  const e = parseExpression('a or b and not c => d');
  assert.equal(e.kind, 'binary');
  assert.equal((e as { op: string }).op, 'implies');
});

test('the pretty-printer round-trips every example', () => {
  const strip = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (k === 'span' ? undefined : v)));
  for (const f of readdirSync(path.join(ROOT, 'examples')).filter((x) => x.endsWith('.witness'))) {
    const ast = parseModel(readFileSync(path.join(ROOT, 'examples', f), 'utf8'));
    const again = parseModel(printModel(ast));
    assert.deepEqual(strip(again), strip(ast), f);
  }
});

test('warnings do not block compilation', () => {
  const r = compileSource('model m\nvar x : bool = false\nprocess P { action noop { } }\nfairness weak P');
  assert.ok(r.ok);
  assert.ok(r.diagnostics.some((d) => d.code === 'W205'));
  assert.ok(r.diagnostics.some((d) => d.code === 'W203'));
});

test('parenthesised expressions keep their parentheses in source spans', async () => {
  const { compileSource } = await import('../src/core/model/compile.ts');
  const r = compileSource('model m\nvar a : bool = false\nvar b : bool = false\ninvariant I: (a and b) => b');
  assert.equal(r.model!.invariants[0].text, '(a and b) => b');
});
