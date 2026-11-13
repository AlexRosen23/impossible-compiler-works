// Pretty-printer: AST -> canonical WML source. Used for mutants and normalised diffs.
// Round-trip property (tested): parse(print(ast)) is structurally equal to ast (ignoring spans).
import type { ActionDecl, Expr, ModelAst, TypeExpr, VarDecl } from './ast.ts';

const PREC: Record<string, number> = { implies: 1, or: 2, and: 3, '=': 5, '!=': 5, '<': 5, '<=': 5, '>': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '%': 7 };

export function printExpr(e: Expr, parent = 0): string {
  switch (e.kind) {
    case 'int': return String(e.value);
    case 'bool': return e.value ? 'true' : 'false';
    case 'name': return e.name;
    case 'qualified': return `${e.process}.${e.name}`;
    case 'self': return 'self';
    case 'unary': {
      const s = e.op === 'not' ? `not ${printExpr(e.arg, 4)}` : `-${printExpr(e.arg, 8)}`;
      return parent > (e.op === 'not' ? 4 : 8) ? `(${s})` : s;
    }
    case 'ite': {
      const s = `if ${printExpr(e.cond)} then ${printExpr(e.then)} else ${printExpr(e.else)}`;
      return parent > 0 ? `(${s})` : s;
    }
    case 'binary': {
      const p = PREC[e.op];
      const op = e.op === 'implies' ? '=>' : e.op;
      // left-assoc for arithmetic/and/or, right-assoc for implies; comparisons are non-assoc
      const l = printExpr(e.left, e.op === 'implies' || p === 5 ? p + 1 : p);
      const r = printExpr(e.right, e.op === 'implies' ? p : p + 1);
      const s = `${l} ${op} ${r}`;
      return parent > p ? `(${s})` : s;
    }
  }
}

function printType(t: TypeExpr): string {
  switch (t.kind) {
    case 'bool': return 'bool';
    case 'named': return t.name;
    case 'enum': return `{${t.literals.join(', ')}}`;
    case 'range': return `${printExpr(t.min, 6)}..${printExpr(t.max, 6)}`;
  }
}

function printVar(v: VarDecl, indent: string): string {
  const init = v.init.kind === 'value' ? `= ${printExpr(v.init.expr)}` : `in ${printType(v.init.set)}`;
  return `${indent}var ${v.name} : ${printType(v.type)} ${init}`;
}

function printAction(a: ActionDecl): string {
  const params = a.params.length ? `(${a.params.map((p) => `${p.name} in ${printType(p.domain)}`).join(', ')})` : '';
  const guard = a.guard ? ` when ${printExpr(a.guard)}` : '';
  const body = a.body.map((b) => `    ${b.targetProcess ? `${b.targetProcess}.` : ''}${b.target} := ${printExpr(b.value)}`).join('\n');
  return `  action ${a.name}${params}${guard} {\n${body}${body ? '\n' : ''}  }`;
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function printModel(m: ModelAst): string {
  const out: string[] = [];
  out.push(`model ${m.name} ${q(m.title)}`);
  if (m.description) out.push(`description ${q(m.description)}`);
  out.push('');
  for (const k of m.consts) out.push(`const ${k.name} = ${printExpr(k.value)}`);
  for (const t of m.types) out.push(`type ${t.name} = {${t.literals.join(', ')}}`);
  for (const v of m.vars) out.push(printVar(v, ''));
  for (const p of m.processes) {
    out.push('');
    out.push(`process ${p.names.join(', ')} {`);
    for (const l of p.locals) out.push(printVar(l, '  '));
    for (const a of p.actions) out.push(printAction(a));
    out.push('}');
  }
  out.push('');
  for (const t of m.terminals) out.push(`terminal ${printExpr(t)}`);
  for (const p of m.properties) {
    if (p.kind === 'invariant') out.push(`invariant ${p.name}: ${printExpr(p.expr)}`);
    else if (p.kind === 'eventually') out.push(`liveness ${p.name}: eventually ${printExpr(p.expr)}`);
    else out.push(`liveness ${p.name}: ${printExpr(p.expr)} leadsto ${printExpr(p.target!)}`);
  }
  for (const f of m.fairness) out.push(`fairness ${f.strength} ${f.process}${f.action ? `.${f.action}` : ''}`);
  return out.join('\n') + '\n';
}
