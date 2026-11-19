import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonDepth, MAX_JSON_DEPTH } from '../src/server/json-depth.ts';
import { lineDiff } from '../src/server/diff.ts';
import { DiagnosticError, formatDiagnostic } from '../src/core/diagnostics.ts';
import { compileExpr, EvalError } from '../src/core/engine/evaluate.ts';
import { decodeValue, encodeValue, stateDigest, stateKey } from '../src/core/engine/state.ts';
import { printExpr } from '../src/core/syntax/print.ts';
import type { Expr } from '../src/core/syntax/ast.ts';
import type { IrExpr } from '../src/core/model/ir.ts';

// ---- jsonDepth
test('jsonDepth counts bracket nesting, ignores brackets inside strings and escaped quotes', () => {
  assert.equal(jsonDepth('1'), 0);
  assert.equal(jsonDepth('[]'), 1);
  assert.equal(jsonDepth('{"a":[{"b":[]}]}'), 4);
  assert.equal(jsonDepth('["[[[[", "]]]]"]'), 1);
  assert.equal(jsonDepth('["a\\"[[[", 1]'), 1); // the escaped quote does not end the string
  assert.equal(jsonDepth('[1][2]'), 1); // siblings do not add up
});

test('jsonDepth handles hostile depth without recursion and the limit is what the servers rely on', () => {
  const n = 200_000;
  assert.equal(jsonDepth('['.repeat(n) + ']'.repeat(n)), n);
  assert.ok(jsonDepth('['.repeat(MAX_JSON_DEPTH + 1)) > MAX_JSON_DEPTH);
  assert.ok(jsonDepth('['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH)) <= MAX_JSON_DEPTH);
});

// ---- lineDiff
test('lineDiff marks equal, removed and added lines with 1-based numbers', () => {
  const d = lineDiff('a\nb\nc', 'a\nx\nc\nd');
  assert.deepEqual(d, [
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: '-', text: 'b', a: 2 },
    { op: '+', text: 'x', b: 2 },
    { op: ' ', text: 'c', a: 3, b: 3 },
    { op: '+', text: 'd', b: 4 },
  ]);
});

test('lineDiff of identical text has no changes, and applying the diff reproduces both sides', () => {
  const a = 'one\ntwo\nthree\nfour', b = 'zero\none\nthree\nfive\nsix';
  assert.ok(lineDiff(a, a).every((l) => l.op === ' '));
  const d = lineDiff(a, b);
  assert.equal(d.filter((l) => l.op !== '+').map((l) => l.text).join('\n'), a);
  assert.equal(d.filter((l) => l.op !== '-').map((l) => l.text).join('\n'), b);
});

test('lineDiff refuses inputs too large to compute instead of allocating the table', () => {
  const big = Array.from({ length: 2100 }, (_, i) => `l${i}`).join('\n');
  assert.deepEqual(lineDiff(big, big + '\nx'), [{ op: '-', text: '(diff too large to compute)' }]);
});

// ---- diagnostics
test('formatDiagnostic shows severity, code, position or a dash', () => {
  const span = { line: 3, col: 9, offset: 20, end: 24 };
  assert.equal(formatDiagnostic({ code: 'E001', severity: 'error', message: 'boom', span }), 'ERROR E001 at 3:9: boom');
  assert.equal(formatDiagnostic({ code: 'W2', severity: 'warning', message: 'hm' }), 'WARNING W2 at -: hm');
});

test('DiagnosticError round-trips into a Diagnostic', () => {
  const span = { line: 1, col: 1, offset: 0, end: 1 };
  const e = new DiagnosticError('E9', 'bad', span);
  assert.ok(e instanceof Error);
  assert.deepEqual(e.toDiagnostic(), { code: 'E9', severity: 'error', message: 'bad', span });
  assert.equal(new DiagnosticError('E9', 'bad', undefined).toDiagnostic().span, undefined);
});

// ---- compiled expression evaluator
const c = (v: number): IrExpr => ({ k: 'const', v, t: 'int' });
const v = (i: number): IrExpr => ({ k: 'var', i });
const bin = (op: string, a: IrExpr, b: IrExpr): IrExpr => ({ k: 'bin', op, a, b }) as IrExpr;
const run = (e: IrExpr, s: number[] = []) => compileExpr(e)(Int32Array.from(s));

test('evaluator: comparisons and booleans yield 0/1', () => {
  assert.equal(run(bin('<', v(0), v(1)), [1, 2]), 1);
  assert.equal(run(bin('>=', v(0), v(1)), [1, 2]), 0);
  assert.equal(run(bin('!=', v(0), c(5)), [4]), 1);
  assert.equal(run(bin('and', c(7), c(3))), 1);
  assert.equal(run(bin('or', c(0), c(0))), 0);
  assert.equal(run(bin('implies', c(0), c(0))), 1);
  assert.equal(run(bin('implies', c(1), c(0))), 0);
  assert.equal(run({ k: 'un', op: 'not', a: c(5) } as IrExpr), 0);
  assert.equal(run({ k: 'un', op: 'neg', a: c(5) } as IrExpr), -5);
});

test('evaluator: and/or/implies short-circuit, so a faulting right side is never evaluated', () => {
  const boom = bin('%', c(1), c(0));
  assert.equal(run(bin('and', c(0), boom)), 0);
  assert.equal(run(bin('or', c(1), boom)), 1);
  assert.equal(run(bin('implies', c(0), boom)), 1);
  assert.throws(() => run(bin('and', c(1), boom)), EvalError);
});

test('evaluator: modulo is non-negative and refuses non-positive divisors', () => {
  assert.equal(run(bin('%', c(-1), c(3))), 2);
  assert.equal(run(bin('%', c(7), c(3))), 1);
  assert.throws(() => run(bin('%', c(5), c(0))), /modulo by non-positive/);
  assert.throws(() => run(bin('%', c(5), c(-2))), /modulo by non-positive/);
});

test('evaluator: arithmetic overflow past 2^31-1 is an error, the boundary itself is fine', () => {
  const MAX = 2_147_483_647;
  assert.equal(run(bin('+', c(MAX - 1), c(1))), MAX);
  assert.throws(() => run(bin('+', c(MAX), c(1))), /overflow/);
  assert.throws(() => run(bin('*', c(65536), c(65536))), /overflow/);
  assert.throws(() => run(bin('-', c(-MAX), c(1))), /overflow/);
});

test('evaluator: if-then-else only runs the chosen branch', () => {
  const e = { k: 'ite', c: v(0), t: c(10), e: bin('%', c(1), c(0)) } as IrExpr;
  assert.equal(run(e, [1]), 10);
  assert.throws(() => run(e, [0]), EvalError);
});

// ---- state encoding
const model = {
  literals: ['idle', 'busy'],
  vars: [
    { name: 'flag', index: 0, type: { kind: 'bool' } },
    { name: 'mode', index: 1, type: { kind: 'enum' } },
    { name: 'n', index: 2, type: { kind: 'range' } },
  ],
} as never as Parameters<typeof stateDigest>[0];
const [fv, mv, nv] = (model as unknown as { vars: never[] }).vars as Parameters<typeof decodeValue>[1][];

test('stateKey is an exact comma-joined content key', () => {
  assert.equal(stateKey(Int32Array.from([1, 0, -5])), '1,0,-5');
  assert.equal(stateKey([]), '');
  assert.notEqual(stateKey([1, 23]), stateKey([12, 3]));
});

test('encodeValue/decodeValue round-trip and reject wrong types', () => {
  assert.equal(encodeValue(model, fv, true), 1);
  assert.equal(decodeValue(model, fv, 0), false);
  assert.equal(encodeValue(model, mv, 'busy'), 1);
  assert.equal(decodeValue(model, mv, 1), 'busy');
  assert.equal(decodeValue(model, mv, 9), '?9');
  assert.equal(encodeValue(model, nv, 42), 42);
  assert.throws(() => encodeValue(model, fv, 1 as never), /expected boolean/);
  assert.throws(() => encodeValue(model, mv, 'gone'), /unknown literal/);
  assert.throws(() => encodeValue(model, mv, 3 as never), /expected literal/);
  assert.throws(() => encodeValue(model, nv, 1.5), /expected integer/);
  assert.throws(() => encodeValue(model, nv, '1' as never), /expected integer/);
});

test('stateDigest depends on every variable and is stable', () => {
  const a = stateDigest(model, Int32Array.from([1, 0, 3]));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, stateDigest(model, Int32Array.from([1, 0, 3])));
  for (const other of [[0, 0, 3], [1, 1, 3], [1, 0, 4]]) assert.notEqual(a, stateDigest(model, Int32Array.from(other)));
});

// ---- printer precedence
const sp = { line: 1, col: 1, offset: 0, end: 0 };
const n = (value: number): Expr => ({ kind: 'int', value, span: sp });
const b = (op: string, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right, span: sp }) as Expr;

test('printExpr adds parentheses exactly where precedence/associativity requires them', () => {
  assert.equal(printExpr(b('*', b('+', n(1), n(2)), n(3))), '(1 + 2) * 3');
  assert.equal(printExpr(b('+', n(1), b('*', n(2), n(3)))), '1 + 2 * 3');
  assert.equal(printExpr(b('-', n(1), b('-', n(2), n(3)))), '1 - (2 - 3)'); // left-assoc: right operand needs parens
  assert.equal(printExpr(b('-', b('-', n(1), n(2)), n(3))), '1 - 2 - 3');
  assert.equal(printExpr(b('implies', n(1), b('implies', n(2), n(3)))), '1 => 2 => 3'); // right-assoc
  assert.equal(printExpr(b('implies', b('implies', n(1), n(2)), n(3))), '(1 => 2) => 3');
  assert.equal(printExpr(b('=', b('=', n(1), n(2)), n(3))), '(1 = 2) = 3'); // comparisons are non-assoc
  assert.equal(printExpr({ kind: 'unary', op: 'not', arg: b('and', n(1), n(2)), span: sp } as Expr), 'not (1 and 2)');
  assert.equal(printExpr({ kind: 'unary', op: 'neg', arg: n(4), span: sp } as Expr), '-4');
});
