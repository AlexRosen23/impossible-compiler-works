// Deterministic test-case reducer (greedy delta debugging over the AST). Given a failing program and a
// predicate "still fails the same way", it repeatedly tries smaller variants in a fixed order and keeps the
// first one that still fails, until no candidate does. Candidates: delete a statement, replace an `if` by its
// branch, shrink a loop bound, replace an expression by a literal of the same type, replace a binary
// expression by one of its operands. Every candidate must still parse and type-check.
import type * as A from './ast.ts';
import { check } from './checker.ts';
import { formatProgram } from './format.ts';
import { parse } from './parser.ts';
import { hasErrors } from './diagnostics.ts';

type Edit = (p: A.Program) => boolean;

const literalFor = (t: string): A.Expr | null => {
  const S = { start: 0, end: 0, line: 1, col: 1 };
  if (t === 'Number') return { kind: 'Num', id: 0, value: 1, span: S };
  if (t === 'Boolean') return { kind: 'Bool', id: 0, value: true, span: S };
  if (t === 'String') return { kind: 'Str', id: 0, value: '', span: S };
  if (t === 'Color') return { kind: 'Color', id: 0, value: '#000000', span: S };
  return null;
};

function candidates(p: A.Program, types: Map<number, string>): Edit[] {
  const edits: Edit[] = [];
  let blockIdx = 0;
  const blocks: A.Block[] = [];
  const exprs: A.Expr[] = [];
  const walkExpr = (e: A.Expr) => { exprs.push(e); if (e.kind === 'Binary') { walkExpr(e.left); walkExpr(e.right); } else if (e.kind === 'Unary') walkExpr(e.operand); else if (e.kind === 'Call') e.args.forEach(walkExpr); else if (e.kind === 'Index') { walkExpr(e.target); walkExpr(e.index); } else if (e.kind === 'Field') walkExpr(e.target); else if (e.kind === 'List') e.items.forEach(walkExpr); };
  const walkBlock = (b: A.Block) => {
    blocks.push(b);
    for (const s of b.stmts) {
      if (s.kind === 'If') { walkExpr(s.cond); walkBlock(s.then); if (s.else) walkBlock(s.else.kind === 'If' ? { kind: 'Block', id: -1, stmts: [s.else], span: s.span } : s.else); }
      else if (s.kind === 'Repeat') { [s.from, s.to, s.iterable].forEach((x) => x && walkExpr(x)); walkBlock(s.body); }
      else if (s.kind === 'Group') { s.args.forEach((a) => walkExpr(a.value)); walkBlock(s.body); }
      else if (s.kind === 'Draw') s.args.forEach((a) => walkExpr(a.value));
      else if (s.kind === 'Let') walkExpr(s.init);
      else if (s.kind === 'Assign') walkExpr(s.value);
      else if (s.kind === 'Return') walkExpr(s.value);
      else if (s.kind === 'Assert') walkExpr(s.cond);
    }
  };
  for (const it of p.items) if (it.kind !== 'DataDecl') walkBlock(it.body);
  // Positional addressing: edit k is re-applied to a fresh clone by walking in the same order.
  blocks.forEach((b, bi) => b.stmts.forEach((s, si) => {
    edits.push((q) => { const bb = collectBlocks(q)[bi]; if (!bb || bb.id === -1) return false; bb.stmts.splice(si, 1); return true; });
    if (s.kind === 'If') edits.push((q) => { const bb = collectBlocks(q)[bi]; if (!bb || bb.id === -1) return false; const st = bb.stmts[si] as A.IfStmt; bb.stmts.splice(si, 1, ...st.then.stmts); return true; });
    if (s.kind === 'Repeat' && s.to && !(s.to.kind === 'Num' && s.to.value <= 1)) edits.push((q) => { const st = collectBlocks(q)[bi]?.stmts[si] as A.RepeatStmt; if (!st?.to) return false; st.to = { kind: 'Num', id: 0, value: 1, span: st.to.span }; return true; });
    if (s.kind === 'Group') edits.push((q) => { const bb = collectBlocks(q)[bi]; const st = bb?.stmts[si] as A.GroupStmt; if (!st) return false; bb.stmts.splice(si, 1, ...st.body.stmts); return true; });
  }));
  void blockIdx;
  exprs.forEach((e, ei) => {
    const lit = literalFor(types.get(e.id) ?? '');
    if (lit && !(e.kind === lit.kind)) edits.push((q) => replaceExpr(q, ei, () => lit));
    if (e.kind === 'Binary') {
      edits.push((q) => replaceExpr(q, ei, (x) => (x as A.BinaryExpr).left));
      edits.push((q) => replaceExpr(q, ei, (x) => (x as A.BinaryExpr).right));
    }
  });
  return edits;
}

function collectBlocks(p: A.Program): A.Block[] {
  const out: A.Block[] = [];
  const walk = (b: A.Block) => {
    out.push(b);
    for (const s of b.stmts) {
      if (s.kind === 'If') { walk(s.then); if (s.else) walk(s.else.kind === 'If' ? { kind: 'Block', id: -1, stmts: [s.else], span: s.span } : s.else); }
      else if (s.kind === 'Repeat') walk(s.body);
      else if (s.kind === 'Group') walk(s.body);
    }
  };
  for (const it of p.items) if (it.kind !== 'DataDecl') walk(it.body);
  return out;
}

function replaceExpr(p: A.Program, index: number, f: (e: A.Expr) => A.Expr): boolean {
  let k = 0;
  let done = false;
  const visit = (e: A.Expr): A.Expr => {
    if (done) return e;
    if (k++ === index) { done = true; return f(e); }
    switch (e.kind) {
      case 'Binary': e.left = visit(e.left); e.right = visit(e.right); break;
      case 'Unary': e.operand = visit(e.operand); break;
      case 'Call': e.args = e.args.map(visit); break;
      case 'Index': e.target = visit(e.target); e.index = visit(e.index); break;
      case 'Field': e.target = visit(e.target); break;
      case 'List': e.items = e.items.map(visit); break;
    }
    return e;
  };
  const walk = (b: A.Block) => {
    for (const s of b.stmts) {
      if (s.kind === 'If') { s.cond = visit(s.cond); walk(s.then); if (s.else) walk(s.else.kind === 'If' ? { kind: 'Block', id: -1, stmts: [s.else], span: s.span } : s.else); }
      else if (s.kind === 'Repeat') { if (s.from) s.from = visit(s.from); if (s.to) s.to = visit(s.to); if (s.iterable) s.iterable = visit(s.iterable); walk(s.body); }
      else if (s.kind === 'Group') { s.args.forEach((a) => { a.value = visit(a.value); }); walk(s.body); }
      else if (s.kind === 'Draw') s.args.forEach((a) => { a.value = visit(a.value); });
      else if (s.kind === 'Let') s.init = visit(s.init);
      else if (s.kind === 'Assign') s.value = visit(s.value);
      else if (s.kind === 'Return') s.value = visit(s.value);
      else if (s.kind === 'Assert') s.cond = visit(s.cond);
    }
  };
  for (const it of p.items) if (it.kind !== 'DataDecl') walk(it.body);
  return done;
}

export interface ReduceResult { source: string; steps: number; tried: number; originalLength: number }

export function reduce(source: string, stillFails: (src: string) => boolean, maxTries = 3000): ReduceResult {
  let current = source;
  let steps = 0, tried = 0;
  outer: for (;;) {
    const parsed = parse(current);
    if (!parsed.program) break;
    const c = check(parsed.program);
    const cands = candidates(parsed.program, c.types);
    for (const edit of cands) {
      if (tried >= maxTries) break outer;
      const clone = structuredClone(parsed.program);
      if (!edit(clone)) continue;
      const src = formatProgram(clone);
      if (src === current) continue;
      tried++;
      const p2 = parse(src);
      if (!p2.program || hasErrors(p2.diagnostics) || hasErrors(check(p2.program).diagnostics)) continue;
      if (stillFails(src)) { current = src; steps++; continue outer; }
    }
    break;
  }
  return { source: current, steps, tried, originalLength: source.length };
}
