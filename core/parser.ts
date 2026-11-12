// FOLIO parser: tokens → AST. Hand-written recursive descent (see docs/ARCHITECTURE.md for why no generator):
// one function per grammar production in docs/FOLIO_LANGUAGE_SPEC.md §3, precise spans, "expected X, found Y"
// diagnostics built from the actual alternatives at the failure point, and panic-mode recovery to the next
// `;` or `}` so one mistake does not hide the rest.
import type * as A from './ast.ts';
import { countNodes } from './ast.ts';
import { type Diagnostic, type Span, spanFrom } from './diagnostics.ts';
import { lex, type Token } from './lexer.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';

export interface ParseResult { program: A.Program | null; tokens: Token[]; diagnostics: Diagnostic[] }

class Bail extends Error {}

export function parse(src: string, limits: Limits = DEFAULT_LIMITS): ParseResult {
  const lexed = lex(src, limits);
  const p = new Parser(lexed.tokens.filter((t) => t.kind !== 'comment'), limits);
  const diagnostics = [...lexed.diagnostics];
  if (lexed.diagnostics.some((d) => d.code === 'S001')) return { program: null, tokens: lexed.tokens, diagnostics };
  let program: A.Program | null = null;
  try {
    program = p.program();
  } catch (e) {
    if (!(e instanceof Bail)) throw e;
  }
  diagnostics.push(...p.diagnostics);
  if (program) {
    const n = countNodes(program);
    if (n > limits.maxAstNodes) {
      diagnostics.push({ code: 'S002', severity: 'error', message: `program has ${n} syntax nodes; the limit is ${limits.maxAstNodes}`, span: program.span, stage: 'limits' });
    }
  }
  return { program, tokens: lexed.tokens, diagnostics };
}

const SYNC = new Set([';', '}']);
const STMT_START = ['let', 'var', 'if', 'repeat', 'return', 'assert', 'group', '<name>'];

class Parser {
  pos = 0;
  nextId = 1;
  diagnostics: Diagnostic[] = [];
  depth = 0;
  private toks: Token[];
  private limits: Limits;
  constructor(toks: Token[], limits: Limits) { this.toks = toks; this.limits = limits; }

  // --- token helpers -------------------------------------------------------------------------
  peek(o = 0): Token { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  at(text: string): boolean { const t = this.peek(); return (t.kind === 'punct' || t.kind === 'keyword') && t.text === text; }
  next(): Token { const t = this.peek(); if (this.pos < this.toks.length - 1) this.pos++; return t; }
  eat(text: string): boolean { if (this.at(text)) { this.next(); return true; } return false; }
  atWord(text: string): boolean { const t = this.peek(); return t.kind === 'ident' && t.text === text; }
  eatWord(text: string): boolean { if (this.atWord(text)) { this.next(); return true; } return false; }
  prevEnd(): Span { return this.toks[Math.max(0, this.pos - 1)].span; }
  id(): number { return this.nextId++; }

  describe(t: Token): string {
    if (t.kind === 'eof') return 'end of file';
    if (t.kind === 'error') return `invalid token "${t.text}"`;
    return `${t.kind === 'ident' ? 'name' : t.kind} "${t.text}"`;
  }
  fail(expected: string[], hint?: string): never {
    const t = this.peek();
    const exp = expected.length === 1 ? expected[0] : expected.slice(0, -1).join(', ') + ' or ' + expected[expected.length - 1];
    this.error('P001', `expected ${exp}, found ${this.describe(t)}`, t.span, hint);
    throw new Recover();
  }
  error(code: string, message: string, span: Span, hint?: string) {
    // A lexer error already explains an `error` token; don't stack a parse error on top of it.
    if (this.peek().kind === 'error' && code === 'P001' && span === this.peek().span) return;
    this.diagnostics.push({ code, severity: 'error', message, span, hint, stage: 'parse' });
    if (this.diagnostics.length >= this.limits.maxErrors) {
      this.diagnostics.push({ code: 'P005', severity: 'error', message: `stopped after ${this.limits.maxErrors} syntax errors`, span, stage: 'parse' });
      throw new Bail();
    }
  }
  expect(text: string, hint?: string): Token {
    if (this.at(text)) return this.next();
    this.fail([`"${text}"`], hint);
  }
  ident(what = 'a name'): Token {
    const t = this.peek();
    if (t.kind === 'ident') return this.next();
    if (t.kind === 'keyword' || t.kind === 'type') this.fail([what], `"${t.text}" is reserved and cannot be used as a name`);
    this.fail([what]);
  }
  sync() {
    // Panic-mode recovery: skip to just after the next `;`, or stop before a `}` / statement keyword.
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && SYNC.has(t.text)) { if (t.text === ';') this.next(); return; }
      if (t.kind === 'keyword' && ['let', 'var', 'if', 'repeat', 'return', 'assert', 'fn', 'scene', 'data', 'group'].includes(t.text)) return;
      this.next();
    }
  }

  // --- items ---------------------------------------------------------------------------------
  program(): A.Program {
    const start = this.peek().span;
    const items: A.Item[] = [];
    while (this.peek().kind !== 'eof') {
      const before = this.pos;
      try {
        if (this.at('fn')) items.push(this.fnDecl());
        else if (this.at('data')) items.push(this.dataDecl());
        else if (this.at('scene')) items.push(this.sceneDecl());
        else this.fail(['"scene"', '"fn"', '"data"'], 'a FOLIO file is a list of fn and data declarations plus exactly one scene');
      } catch (e) {
        if (!(e instanceof Recover)) throw e;
        this.sync();
        if (this.at('}')) this.next();
        if (this.pos === before) this.next();
      }
    }
    const scenes = items.filter((i) => i.kind === 'SceneDecl');
    if (scenes.length === 0 && this.diagnostics.length === 0) {
      this.error('P002', 'no scene declaration: a program needs exactly one `scene "Title" { ... }`', this.peek().span);
    }
    for (const s of scenes.slice(1)) this.error('P003', 'a program has exactly one scene', s.span);
    return { kind: 'Program', id: 0, items, span: spanFrom(start, this.peek().span) };
  }

  typeRef(): A.TypeNode {
    const t = this.peek();
    if (t.kind !== 'type') this.fail(['a type (Number, Boolean, String, Color, Point or List<T>)']);
    this.next();
    if (t.text === 'List') {
      this.expect('<');
      const elem = this.typeRef();
      const close = this.expect('>');
      return { kind: 'TypeRef', id: this.id(), name: 'List', elem, span: spanFrom(t.span, close.span) };
    }
    return { kind: 'TypeRef', id: this.id(), name: t.text as A.PrimTypeName, elem: null, span: t.span };
  }

  fnDecl(): A.FnDecl {
    const kw = this.expect('fn');
    const name = this.ident('a function name');
    this.expect('(');
    const params: A.Param[] = [];
    while (!this.at(')')) {
      const pn = this.ident('a parameter name');
      this.expect(':', 'parameters need a type: `name: Number`');
      const type = this.typeRef();
      params.push({ kind: 'Param', id: this.id(), name: pn.text, type, span: spanFrom(pn.span, type.span) });
      if (!this.eat(',')) break;
    }
    this.expect(')');
    this.expect('->', 'functions declare their return type: `fn f(x: Number) -> Number { ... }`');
    const ret = this.typeRef();
    const body = this.block();
    return { kind: 'FnDecl', id: this.id(), name: name.text, nameSpan: name.span, params, ret, body, span: spanFrom(kw.span, body.span) };
  }

  dataDecl(): A.DataDecl {
    const kw = this.expect('data');
    const name = this.ident('a dataset name');
    this.expect(':');
    const type = this.typeRef();
    if (!this.eatWord('from')) this.fail(['"from"']);
    const f = this.peek();
    if (f.kind !== 'string') this.fail(['a fixture name in quotes'], 'datasets come only from project fixtures: data rain: List<Number> from "rainfall";');
    this.next();
    const semi = this.expect(';');
    return { kind: 'DataDecl', id: this.id(), name: name.text, nameSpan: name.span, type, fixture: String(f.value), fixtureSpan: f.span, span: spanFrom(kw.span, semi.span) };
  }

  sceneDecl(): A.SceneDecl {
    const kw = this.expect('scene');
    const title = this.peek();
    if (title.kind !== 'string') this.fail(['a scene title in quotes']);
    this.next();
    const options: A.SceneOption[] = [];
    for (;;) {
      const o = this.peek();
      if (this.eatWord('size')) {
        const w = this.number();
        const x = this.peek();
        if (!(x.kind === 'ident' && x.text === 'x')) this.fail(['"x"'], 'write the canvas size as `size 800 x 480`');
        this.next();
        const h = this.number();
        options.push({ name: 'size', values: [w, h], span: spanFrom(o.span, this.prevEnd()) });
      } else if (this.eatWord('frames')) {
        options.push({ name: 'frames', values: [this.number()], span: spanFrom(o.span, this.prevEnd()) });
      } else if (this.eatWord('background')) {
        const c = this.peek();
        if (c.kind !== 'color') this.fail(['a colour literal like #101013']);
        this.next();
        options.push({ name: 'background', values: [String(c.value)], span: spanFrom(o.span, c.span) });
      } else break;
    }
    if (!this.at('{')) this.fail(['"{"', '"size"', '"frames"', '"background"']);
    const body = this.block();
    return { kind: 'SceneDecl', id: this.id(), title: String(title.value), options, body, span: spanFrom(kw.span, body.span) };
  }

  number(): number {
    const t = this.peek();
    if (t.kind !== 'number') this.fail(['a number']);
    this.next();
    return t.value as number;
  }

  // --- statements ----------------------------------------------------------------------------
  block(): A.Block {
    const open = this.expect('{');
    const stmts: A.Stmt[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      const before = this.pos;
      try {
        stmts.push(this.stmt());
      } catch (e) {
        if (!(e instanceof Recover)) throw e;
        this.sync();
        if (this.pos === before) this.next();
      }
    }
    const close = this.expect('}');
    return { kind: 'Block', id: this.id(), stmts, span: spanFrom(open.span, close.span) };
  }

  stmt(): A.Stmt {
    const t = this.peek();
    if (this.at('let') || this.at('var')) {
      this.next();
      const name = this.ident();
      let type: A.TypeNode | null = null;
      if (this.eat(':')) type = this.typeRef();
      this.expect('=', t.text === 'let' ? 'a let binding needs a value: `let r: Number = 4;`' : undefined);
      const init = this.expr();
      const semi = this.expect(';');
      return { kind: 'Let', id: this.id(), mutable: t.text === 'var', name: name.text, nameSpan: name.span, type, init, span: spanFrom(t.span, semi.span) };
    }
    if (this.at('if')) return this.ifStmt();
    if (this.at('repeat')) {
      this.next();
      const name = this.ident('a loop variable');
      this.expect('in');
      const first = this.expr();
      let from: A.Expr | null = null, to: A.Expr | null = null, iterable: A.Expr | null = null;
      if (this.eat('..')) { from = first; to = this.expr(); } else iterable = first;
      const body = this.block();
      return { kind: 'Repeat', id: this.id(), name: name.text, nameSpan: name.span, from, to, iterable, body, span: spanFrom(t.span, body.span) };
    }
    if (this.at('return')) {
      this.next();
      const value = this.expr();
      const semi = this.expect(';');
      return { kind: 'Return', id: this.id(), value, span: spanFrom(t.span, semi.span) };
    }
    if (this.at('assert')) {
      this.next();
      const cond = this.expr();
      let message: string | null = null;
      if (this.eat(',')) {
        const m = this.peek();
        if (m.kind !== 'string') this.fail(['an assertion message in quotes']);
        this.next();
        message = String(m.value);
      }
      const semi = this.expect(';');
      return { kind: 'Assert', id: this.id(), cond, message, span: spanFrom(t.span, semi.span) };
    }
    if (this.at('group')) {
      this.next();
      const args = this.namedArgs();
      const body = this.block();
      return { kind: 'Group', id: this.id(), args, body, span: spanFrom(t.span, body.span) };
    }
    if (t.kind === 'ident') {
      if (this.peek(1).kind === 'punct' && this.peek(1).text === '(') {
        this.next();
        const args = this.namedArgs();
        const semi = this.expect(';');
        return { kind: 'Draw', id: this.id(), prim: t.text, primSpan: t.span, args, span: spanFrom(t.span, semi.span) };
      }
      if (this.peek(1).kind === 'punct' && this.peek(1).text === '=') {
        this.next(); this.next();
        const value = this.expr();
        const semi = this.expect(';');
        return { kind: 'Assign', id: this.id(), name: t.text, nameSpan: t.span, value, span: spanFrom(t.span, semi.span) };
      }
      this.next();
      this.fail(['"(" (a drawing call)', '"=" (an assignment)']);
    }
    this.fail(STMT_START.map((s) => (s === '<name>' ? 'a drawing call or assignment' : `"${s}"`)), t.kind === 'punct' && t.text === '}' ? undefined : undefined);
  }

  ifStmt(): A.IfStmt {
    const kw = this.expect('if');
    const cond = this.expr();
    const then = this.block();
    let els: A.Block | A.IfStmt | null = null;
    if (this.eat('else')) els = this.at('if') ? this.ifStmt() : this.block();
    return { kind: 'If', id: this.id(), cond, then, else: els, span: spanFrom(kw.span, (els ?? then).span) };
  }

  namedArgs(): A.NamedArg[] {
    this.expect('(');
    const args: A.NamedArg[] = [];
    while (!this.at(')')) {
      const n = this.ident('an argument name');
      this.expect(':', 'drawing calls use named arguments: `circle(x: 10, y: 20, radius: 5)`');
      const value = this.expr();
      args.push({ kind: 'NamedArg', id: this.id(), name: n.text, nameSpan: n.span, value, span: spanFrom(n.span, value.span) });
      if (!this.eat(',')) break;
    }
    this.expect(')');
    return args;
  }

  // --- expressions (precedence climbing, lowest first) ---------------------------------------
  expr(): A.Expr {
    if (++this.depth > this.limits.maxExprDepth) {
      this.error('S002', `expression nested more than ${this.limits.maxExprDepth} levels`, this.peek().span);
      throw new Bail();
    }
    try { return this.or(); } finally { this.depth--; }
  }
  bin(sub: () => A.Expr, ops: string[], nonAssoc = false): A.Expr {
    let left = sub();
    while (ops.some((o) => this.at(o))) {
      const op = this.next().text as A.BinaryOp;
      const right = sub();
      left = { kind: 'Binary', id: this.id(), op, left, right, span: spanFrom(left.span, right.span) };
      if (nonAssoc && ops.some((o) => this.at(o))) {
        this.error('P001', `comparisons do not chain: write (a ${op} b) and (b ${this.peek().text} c)`, this.peek().span);
        throw new Recover();
      }
    }
    return left;
  }
  or(): A.Expr { return this.bin(() => this.and(), ['or']); }
  and(): A.Expr { return this.bin(() => this.equality(), ['and']); }
  equality(): A.Expr { return this.bin(() => this.compare(), ['==', '!='], true); }
  compare(): A.Expr { return this.bin(() => this.additive(), ['<', '<=', '>', '>='], true); }
  additive(): A.Expr { return this.bin(() => this.mult(), ['+', '-']); }
  mult(): A.Expr { return this.bin(() => this.unary(), ['*', '/', '%']); }
  unary(): A.Expr {
    if (this.at('-') || this.at('not')) {
      const op = this.next();
      if (++this.depth > this.limits.maxExprDepth) {
        this.error('S002', `expression nested more than ${this.limits.maxExprDepth} levels`, op.span);
        throw new Bail();
      }
      try {
        const operand = this.unary();
        return { kind: 'Unary', id: this.id(), op: op.text as A.UnaryOp, operand, span: spanFrom(op.span, operand.span) };
      } finally { this.depth--; }
    }
    return this.postfix();
  }
  postfix(): A.Expr {
    let e = this.primary();
    for (;;) {
      if (this.eat('[')) {
        const index = this.expr();
        const close = this.expect(']');
        e = { kind: 'Index', id: this.id(), target: e, index, span: spanFrom(e.span, close.span) };
      } else if (this.at('.') ) {
        this.next();
        const f = this.ident('a field name (x or y)');
        e = { kind: 'Field', id: this.id(), target: e, field: f.text, fieldSpan: f.span, span: spanFrom(e.span, f.span) };
      } else return e;
    }
  }
  primary(): A.Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'number': this.next(); return { kind: 'Num', id: this.id(), value: t.value as number, span: t.span };
      case 'string': this.next(); return { kind: 'Str', id: this.id(), value: t.value as string, span: t.span };
      case 'color': this.next(); return { kind: 'Color', id: this.id(), value: t.value as string, span: t.span };
      case 'keyword':
        if (t.text === 'true' || t.text === 'false') { this.next(); return { kind: 'Bool', id: this.id(), value: t.text === 'true', span: t.span }; }
        break;
      case 'ident': {
        this.next();
        if (this.eat('(')) {
          const args: A.Expr[] = [];
          while (!this.at(')')) {
            if (this.peek().kind === 'ident' && this.peek(1).kind === 'punct' && this.peek(1).text === ':') {
              this.fail(['an expression'], `"${t.text}" takes positional arguments; named arguments are only for drawing calls`);
            }
            args.push(this.expr());
            if (!this.eat(',')) break;
          }
          const close = this.expect(')');
          return { kind: 'Call', id: this.id(), callee: t.text, calleeSpan: t.span, args, span: spanFrom(t.span, close.span) };
        }
        return { kind: 'Name', id: this.id(), name: t.text, span: t.span };
      }
      case 'punct':
        if (t.text === '(') {
          this.next();
          const e = this.expr();
          this.expect(')');
          return e;
        }
        if (t.text === '[') {
          this.next();
          const items: A.Expr[] = [];
          while (!this.at(']')) { items.push(this.expr()); if (!this.eat(',')) break; }
          const close = this.expect(']');
          return { kind: 'List', id: this.id(), items, span: spanFrom(t.span, close.span) };
        }
        break;
    }
    this.fail(['an expression'], t.kind === 'type' ? `"${t.text}" is a type, not a value` : undefined);
  }
}

class Recover extends Error {}
