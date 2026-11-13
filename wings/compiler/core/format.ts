// Canonical pretty-printer: AST → FOLIO source. Used by "Format" in the IDE, by the fuzzer (generated ASTs
// become source text) and by the reducer. Round-trip property: parse(format(ast)) formats to the same text.
import type * as A from './ast.ts';
import { typeNodeText } from './ast.ts';

const PREC: Record<string, number> = { or: 1, and: 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export function formatProgram(p: A.Program): string {
  const out: string[] = [];
  p.items.forEach((item, i) => {
    if (i > 0) out.push('');
    if (item.kind === 'DataDecl') out.push(`data ${item.name}: ${typeNodeText(item.type)} from ${JSON.stringify(item.fixture)};`);
    else if (item.kind === 'FnDecl') {
      out.push(`fn ${item.name}(${item.params.map((x) => `${x.name}: ${typeNodeText(x.type)}`).join(', ')}) -> ${typeNodeText(item.ret)} {`);
      block(item.body.stmts, 1, out);
      out.push('}');
    } else {
      const opts = item.options.map((o) => (o.name === 'size' ? `size ${o.values[0]} x ${o.values[1]}` : `${o.name} ${o.values[0]}`));
      out.push(`scene ${str(item.title)}${opts.length ? ' ' + opts.join(' ') : ''} {`);
      block(item.body.stmts, 1, out);
      out.push('}');
    }
  });
  return out.join('\n') + '\n';
}

function str(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function block(stmts: A.Stmt[], depth: number, out: string[]) {
  for (const s of stmts) stmt(s, depth, out);
}

function stmt(s: A.Stmt, d: number, out: string[]) {
  const ind = '  '.repeat(d);
  switch (s.kind) {
    case 'Let': out.push(`${ind}${s.mutable ? 'var' : 'let'} ${s.name}${s.type ? `: ${typeNodeText(s.type)}` : ''} = ${expr(s.init)};`); return;
    case 'Assign': out.push(`${ind}${s.name} = ${expr(s.value)};`); return;
    case 'Return': out.push(`${ind}return ${expr(s.value)};`); return;
    case 'Assert': out.push(`${ind}assert ${expr(s.cond)}${s.message !== null ? `, ${str(s.message)}` : ''};`); return;
    case 'Draw': out.push(`${ind}${s.prim}(${args(s.args)});`); return;
    case 'Group': out.push(`${ind}group(${args(s.args)}) {`); block(s.body.stmts, d + 1, out); out.push(`${ind}}`); return;
    case 'Repeat':
      out.push(`${ind}repeat ${s.name} in ${s.iterable ? expr(s.iterable) : `${expr(s.from!)}..${expr(s.to!)}`} {`);
      block(s.body.stmts, d + 1, out);
      out.push(`${ind}}`);
      return;
    case 'If': {
      out.push(`${ind}if ${expr(s.cond)} {`);
      block(s.then.stmts, d + 1, out);
      let e = s.else;
      while (e) {
        if (e.kind === 'If') { out.push(`${ind}} else if ${expr(e.cond)} {`); block(e.then.stmts, d + 1, out); e = e.else; }
        else { out.push(`${ind}} else {`); block(e.stmts, d + 1, out); e = null; }
      }
      out.push(`${ind}}`);
      return;
    }
  }
}

function args(a: A.NamedArg[]): string { return a.map((x) => `${x.name}: ${expr(x.value)}`).join(', '); }

function num(n: number): string {
  if (Number.isInteger(n) || Math.abs(n) >= 1e-6) {
    const s = String(n);
    if (!/e/.test(s)) return s;
  }
  // FOLIO has no exponent syntax: write the full decimal expansion.
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

export function expr(e: A.Expr, parent = 0): string {
  switch (e.kind) {
    case 'Num': return num(e.value);
    case 'Str': return str(e.value);
    case 'Bool': return String(e.value);
    case 'Color': return e.value;
    case 'Name': return e.name;
    case 'List': return `[${e.items.map((x) => expr(x)).join(', ')}]`;
    case 'Call': return `${e.callee}(${e.args.map((x) => expr(x)).join(', ')})`;
    case 'Index': return `${expr(e.target, 9)}[${expr(e.index)}]`;
    case 'Field': return `${expr(e.target, 9)}.${e.field}`;
    case 'Unary': {
      const s = `${e.op === 'not' ? 'not ' : '-'}${expr(e.operand, 8)}`;
      return parent > 7 ? `(${s})` : s;
    }
    case 'Binary': {
      const p = PREC[e.op];
      // Left-associative: the right operand needs parentheses at equal precedence; comparisons never chain.
      const nonAssoc = p === 3 || p === 4;
      const s = `${expr(e.left, nonAssoc ? p + 1 : p)} ${e.op} ${expr(e.right, p + 1)}`;
      return parent > p ? `(${s})` : s;
    }
  }
}
