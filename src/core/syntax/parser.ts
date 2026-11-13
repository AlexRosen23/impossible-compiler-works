import type {
  ActionDecl, Assign, BinOp, ConstDecl, Expr, FairnessDecl, InitSpec, ModelAst, Param,
  ProcessDecl, PropertyDecl, Span, TypeDecl, TypeExpr, VarDecl,
} from './ast.ts';
import { lex, type Token } from './lexer.ts';
import { DiagnosticError } from '../diagnostics.ts';

const MAX_DEPTH = 64;

/** Parse WML source into an AST. Throws DiagnosticError on the first syntax error. */
export function parseModel(source: string): ModelAst {
  return new Parser(lex(source)).parseModel();
}

/** Parse a standalone expression (used by tests and the UI's expression probe). */
export function parseExpression(source: string): Expr {
  const p = new Parser(lex(source));
  const e = p.expr();
  p.expectEof();
  return e;
}

function join(a: Span, b: Span): Span {
  return { line: a.line, col: a.col, offset: a.offset, end: b.end };
}

class Parser {
  private toks: Token[];
  private pos = 0;
  private depth = 0;
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(k = 0): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  private is(text: string, k = 0): boolean {
    const t = this.peek(k);
    return (t.kind === 'punct' || t.kind === 'keyword') && t.text === text;
  }
  private accept(text: string): Token | null {
    if (this.is(text)) return this.next();
    return null;
  }
  private fail(msg: string, t: Token = this.peek()): never {
    throw new DiagnosticError('E100', msg, t.span);
  }
  private expect(text: string, what?: string): Token {
    const t = this.peek();
    if (!this.is(text)) this.fail(`Expected '${text}'${what ? ` ${what}` : ''} but found '${t.text}'.`);
    return this.next();
  }
  private ident(what: string): Token {
    const t = this.peek();
    if (t.kind !== 'ident') {
      if (t.kind === 'keyword') this.fail(`Expected ${what} but found keyword '${t.text}' (keywords cannot be used as names).`);
      this.fail(`Expected ${what} but found '${t.text}'.`);
    }
    return this.next();
  }
  private str(what: string): Token {
    const t = this.peek();
    if (t.kind !== 'string') this.fail(`Expected ${what} (a "quoted string") but found '${t.text}'.`);
    return this.next();
  }
  expectEof(): void {
    if (this.peek().kind !== 'eof') this.fail(`Unexpected '${this.peek().text}' after the end of the expression.`);
  }

  parseModel(): ModelAst {
    const start = this.expect('model', 'at the start of the file (every model begins with `model <name>`)');
    const name = this.ident('a model name').text;
    let title = name;
    const descr: string[] = [];
    if (this.peek().kind === 'string') title = String(this.next().value);
    const m: ModelAst = {
      name, title, description: '', consts: [], types: [], vars: [], processes: [], terminals: [],
      properties: [], fairness: [], span: start.span,
    };
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (this.accept('title')) { title = String(this.str('a title').value); continue; }
      if (this.accept('description')) { descr.push(String(this.str('a description').value)); continue; }
      if (this.is('const')) { m.consts.push(this.constDecl()); continue; }
      if (this.is('type')) { m.types.push(this.typeDecl()); continue; }
      if (this.is('var')) { m.vars.push(this.varDecl()); continue; }
      if (this.is('process')) { m.processes.push(this.processDecl()); continue; }
      if (this.accept('terminal')) { this.accept(':'); m.terminals.push(this.expr()); continue; }
      if (this.is('invariant')) { m.properties.push(this.invariantDecl()); continue; }
      if (this.is('liveness')) { m.properties.push(this.livenessDecl()); continue; }
      if (this.is('fairness')) { m.fairness.push(this.fairnessDecl()); continue; }
      if (this.is('action')) this.fail('Actions must be declared inside a `process { ... }` block.', t);
      this.fail(`Unexpected '${t.text}' at top level. Expected one of: const, type, var, process, terminal, invariant, liveness, fairness.`, t);
    }
    m.title = title;
    m.description = descr.join(' ');
    m.span = join(start.span, this.peek().span);
    return m;
  }

  private constDecl(): ConstDecl {
    const s = this.expect('const');
    const name = this.ident('a constant name').text;
    this.expect('=');
    const value = this.expr();
    return { name, value, span: join(s.span, value.span) };
  }

  private typeDecl(): TypeDecl {
    const s = this.expect('type');
    const name = this.ident('a type name').text;
    this.expect('=');
    const e = this.enumLiterals();
    return { name, literals: e.literals, span: join(s.span, e.span) };
  }

  private enumLiterals(): { literals: string[]; span: Span } {
    const open = this.expect('{', 'to start an enumeration');
    const literals: string[] = [];
    if (!this.is('}')) {
      do {
        literals.push(this.ident('an enumeration literal').text);
      } while (this.accept(','));
    }
    const close = this.expect('}', 'to close the enumeration');
    return { literals, span: join(open.span, close.span) };
  }

  private typeExpr(): TypeExpr {
    const t = this.peek();
    if (this.accept('bool')) return { kind: 'bool', span: t.span };
    if (this.is('{')) {
      const e = this.enumLiterals();
      return { kind: 'enum', literals: e.literals, span: e.span };
    }
    if (t.kind === 'ident' && !this.is('..', 1) && !['+', '-', '*', '%'].some((o) => this.is(o, 1))) {
      this.next();
      return { kind: 'named', name: t.text, span: t.span };
    }
    const min = this.additive();
    this.expect('..', 'in a range type such as 0..3');
    const max = this.additive();
    return { kind: 'range', min, max, span: join(min.span, max.span) };
  }

  private varDecl(): VarDecl {
    const s = this.expect('var');
    const name = this.ident('a variable name').text;
    this.expect(':', `after variable name '${name}' (declare a type, e.g. \`var ${name} : 0..3 = 0\`)`);
    const type = this.typeExpr();
    let init: InitSpec;
    let endSpan: Span;
    if (this.accept('=')) {
      const expr = this.expr();
      init = { kind: 'value', expr };
      endSpan = expr.span;
    } else if (this.accept('in')) {
      const set = this.typeExpr();
      init = { kind: 'set', set };
      endSpan = set.span;
    } else {
      this.fail(`Variable '${name}' needs an initial value: \`= <value>\` or \`in <set>\`.`);
    }
    return { name, type, init, span: join(s.span, endSpan) };
  }

  private processDecl(): ProcessDecl {
    const s = this.expect('process');
    const names: string[] = [];
    do {
      names.push(this.ident('a process name').text);
    } while (this.accept(','));
    this.expect('{', 'to open the process body');
    const locals: VarDecl[] = [];
    const actions: ActionDecl[] = [];
    while (!this.is('}')) {
      if (this.is('var')) { locals.push(this.varDecl()); continue; }
      if (this.is('action')) { actions.push(this.actionDecl()); continue; }
      if (this.peek().kind === 'eof') this.fail('Unterminated process block: missing `}`.');
      this.fail(`Unexpected '${this.peek().text}' inside a process. Expected \`var\` or \`action\`.`);
    }
    const e = this.expect('}');
    return { names, locals, actions, span: join(s.span, e.span) };
  }

  private actionDecl(): ActionDecl {
    const s = this.expect('action');
    const name = this.ident('an action name').text;
    const params: Param[] = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        do {
          const pn = this.ident('a parameter name');
          this.expect('in', `after parameter '${pn.text}' (parameters range over a finite set: \`${pn.text} in 0..2\`)`);
          const domain = this.typeExpr();
          params.push({ name: pn.text, domain, span: join(pn.span, domain.span) });
        } while (this.accept(','));
      }
      this.expect(')');
    }
    let guard: Expr | null = null;
    if (this.accept('when')) guard = this.expr();
    this.expect('{', `to open the body of action '${name}'`);
    const body: Assign[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') this.fail(`Unterminated action '${name}': missing \`}\`.`);
      const t = this.ident('an assignment target (`x := expr`)');
      let target = t.text;
      let targetProcess: string | undefined;
      if (this.accept('.')) {
        targetProcess = t.text;
        target = this.ident('a process-local variable name').text;
      }
      if (this.is('=')) this.fail(`Use ':=' for assignment in action bodies ('=' is comparison).`);
      this.expect(':=', 'in an assignment');
      const value = this.expr();
      body.push({ target, targetProcess, value, span: join(t.span, value.span) });
      while (this.accept(';') || this.accept(',')) { /* optional separators */ }
    }
    const e = this.expect('}');
    return { name, params, guard, body, span: join(s.span, e.span) };
  }

  private invariantDecl(): PropertyDecl {
    const s = this.expect('invariant');
    const name = this.ident('an invariant name').text;
    this.expect(':');
    const expr = this.expr();
    return { name, kind: 'invariant', expr, span: join(s.span, expr.span) };
  }

  private livenessDecl(): PropertyDecl {
    const s = this.expect('liveness');
    const name = this.ident('a liveness property name').text;
    this.expect(':');
    if (this.accept('eventually')) {
      const expr = this.expr();
      return { name, kind: 'eventually', expr, span: join(s.span, expr.span) };
    }
    const p = this.expr();
    if (!this.accept('leadsto')) {
      this.fail('Unsupported liveness form. Supported: `eventually <expr>` and `<expr> leadsto <expr>`. Other temporal operators are refused rather than approximated.');
    }
    const q = this.expr();
    return { name, kind: 'leadsto', expr: p, target: q, span: join(s.span, q.span) };
  }

  private fairnessDecl(): FairnessDecl {
    const s = this.expect('fairness');
    let strength: 'weak' | 'strong';
    if (this.accept('weak')) strength = 'weak';
    else if (this.accept('strong')) strength = 'strong';
    else this.fail('Expected `weak` or `strong` after `fairness`.');
    const p = this.ident('a process name');
    let action: string | undefined;
    let end = p.span;
    if (this.accept('.')) {
      const a = this.ident('an action name');
      action = a.text;
      end = a.span;
    }
    return { strength, process: p.text, action, span: join(s.span, end) };
  }

  // ---- expressions ----------------------------------------------------------------------
  expr(): Expr {
    if (++this.depth > MAX_DEPTH) this.fail(`Expression nesting deeper than ${MAX_DEPTH}.`);
    try {
      return this.implies();
    } finally {
      this.depth--;
    }
  }
  private implies(): Expr {
    const left = this.or();
    if (this.accept('=>')) {
      const right = this.implies();
      return { kind: 'binary', op: 'implies', left, right, span: join(left.span, right.span) };
    }
    return left;
  }
  private or(): Expr {
    let left = this.and();
    while (this.accept('or')) {
      const right = this.and();
      left = { kind: 'binary', op: 'or', left, right, span: join(left.span, right.span) };
    }
    return left;
  }
  private and(): Expr {
    let left = this.not();
    while (this.accept('and')) {
      const right = this.not();
      left = { kind: 'binary', op: 'and', left, right, span: join(left.span, right.span) };
    }
    return left;
  }
  private not(): Expr {
    const t = this.peek();
    if (this.accept('not')) {
      const arg = this.not();
      return { kind: 'unary', op: 'not', arg, span: join(t.span, arg.span) };
    }
    return this.comparison();
  }
  private comparison(): Expr {
    const left = this.additive();
    for (const op of ['=', '!=', '<=', '>=', '<', '>'] as const) {
      if (this.accept(op)) {
        const right = this.additive();
        if (['=', '!=', '<=', '>=', '<', '>'].some((o) => this.is(o))) {
          this.fail('Comparisons cannot be chained; use `and` (e.g. `0 <= x and x <= 3`).');
        }
        return { kind: 'binary', op: op as BinOp, left, right, span: join(left.span, right.span) };
      }
    }
    return left;
  }
  private additive(): Expr {
    let left = this.multiplicative();
    for (;;) {
      if (this.is('+') || this.is('-')) {
        const op = this.next().text as BinOp;
        const right = this.multiplicative();
        left = { kind: 'binary', op, left, right, span: join(left.span, right.span) };
      } else return left;
    }
  }
  private multiplicative(): Expr {
    let left = this.unary();
    for (;;) {
      if (this.is('*') || this.is('%')) {
        const op = this.next().text as BinOp;
        const right = this.unary();
        left = { kind: 'binary', op, left, right, span: join(left.span, right.span) };
      } else return left;
    }
  }
  private unary(): Expr {
    const t = this.peek();
    if (this.accept('-')) {
      const arg = this.unary();
      return { kind: 'unary', op: 'neg', arg, span: join(t.span, arg.span) };
    }
    return this.primary();
  }
  private primary(): Expr {
    const t = this.peek();
    if (t.kind === 'int') { this.next(); return { kind: 'int', value: Number(t.value), span: t.span }; }
    if (this.accept('true')) return { kind: 'bool', value: true, span: t.span };
    if (this.accept('false')) return { kind: 'bool', value: false, span: t.span };
    if (this.accept('self')) return { kind: 'self', span: t.span };
    if (this.accept('(')) {
      const e = this.expr();
      const close = this.expect(')', 'to close the parenthesis');
      return { ...e, span: join(t.span, close.span) };
    }
    if (this.accept('if')) {
      const cond = this.expr();
      this.expect('then', 'in if-then-else');
      const th = this.expr();
      this.expect('else', 'in if-then-else (every `if` needs an `else`)');
      const el = this.expr();
      return { kind: 'ite', cond, then: th, else: el, span: join(t.span, el.span) };
    }
    if (t.kind === 'ident') {
      this.next();
      if (this.is('.') && this.peek(1).kind === 'ident') {
        this.next();
        const n = this.next();
        return { kind: 'qualified', process: t.text, name: n.text, span: join(t.span, n.span) };
      }
      if (this.is('(')) this.fail(`Function calls are not part of the model language ('${t.text}(...)').`);
      return { kind: 'name', name: t.text, span: t.span };
    }
    if (t.kind === 'string') this.fail('Strings are only allowed as titles and descriptions, not in expressions. Use an enumeration literal instead.');
    this.fail(`Expected an expression but found '${t.text}'.`);
  }
}
