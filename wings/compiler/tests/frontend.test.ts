import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CODES, check, compile, lex, parse } from '../core/index.ts';
import { failures } from './helpers.ts';

describe('lexer', () => {
  it('produces tokens with exact spans, categories and decoded values', () => {
    const { tokens, diagnostics } = lex('let r: Number = 4.5; // note\ntext(value: "a\\u{1F42F}b", fill: #B2534F);');
    expect(diagnostics).toEqual([]);
    const show = tokens.map((t) => `${t.kind}:${t.text}@${t.span.line}:${t.span.col}`);
    expect(show.slice(0, 8)).toEqual(['keyword:let@1:1', 'ident:r@1:5', 'punct::@1:6', 'type:Number@1:8', 'punct:=@1:15', 'number:4.5@1:17', 'punct:;@1:20', 'comment:// note@1:22']);
    expect(tokens.find((t) => t.kind === 'string')!.value).toBe('a🐯b');
    expect(tokens.find((t) => t.kind === 'color')!.value).toBe('#b2534f');
    expect(tokens.at(-1)!.kind).toBe('eof');
  });
  it('reports lexical errors with codes and positions and keeps going', () => {
    const { diagnostics } = lex('let a = "open\nlet b = @;\nlet c = "\\q";\nlet d = #12;\n/* never closed');
    expect(diagnostics.map((d) => `${d.code}@${d.span.line}:${d.span.col}`)).toEqual(['L002@1:9', 'L001@2:9', 'L003@3:10', 'L004@4:9', 'L005@5:1']);
  });
  it('rejects oversized sources and string literals', () => {
    expect(lex('x'.repeat(70_000)).diagnostics[0].code).toBe('S001');
    expect(lex(`"${'a'.repeat(1001)}"`).diagnostics[0].code).toBe('L006');
  });
  it('treats size/frames/background/from as contextual words', () => {
    const r = compile('scene "s" size 100 x 100 { text(x: 1, y: 2, value: "v", size: 9); let from = 3; let size = from; circle(x: size, y: 1, radius: 1); }');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('parser', () => {
  it('builds the AST with precedence, associativity and node spans', () => {
    const p = parse('scene "s" { let v = 1 + 2 * 3 - 4 / 2 % 3; let b = not true or false and 1 < 2; }').program!;
    const scene = p.items[0];
    expect(scene.kind).toBe('SceneDecl');
    const let1 = (scene as { body: { stmts: { init: unknown }[] } }).body.stmts[0].init as { op: string; left: { op: string }; right: { op: string } };
    expect(let1.op).toBe('-');
    expect(let1.left.op).toBe('+');
    expect(let1.right.op).toBe('%');
  });
  it('gives expected-token context and recovers to report several errors', () => {
    const r = parse('scene "s" {\n  let a = 4\n  let b = ;\n  circle(x: 1 y: 2, radius: 3);\n}');
    expect(r.diagnostics.map((d) => `${d.code}@${d.span.line}:${d.span.col}`)).toEqual(['P001@3:3', 'P001@3:11', 'P001@4:15']);
    expect(r.diagnostics[0].message).toBe('expected ";", found keyword "let"');
    expect(r.diagnostics[1].message).toBe('expected an expression, found punct ";"');
  });
  it('rejects chained comparisons, missing or duplicate scenes, and deep nesting', () => {
    expect(parse('scene "s" { let a = 1 < 2 < 3; }').diagnostics[0].message).toMatch(/do not chain/);
    expect(parse('fn f(x: Number) -> Number { return x; }').diagnostics[0].code).toBe('P002');
    expect(parse('scene "a" {} scene "b" {}').diagnostics[0].code).toBe('P003');
    expect(parse(`scene "s" { let a = ${'('.repeat(300)}1${')'.repeat(300)}; }`).diagnostics.some((d) => d.code === 'S002')).toBe(true);
    expect(parse(`scene "s" { let a = ${'-'.repeat(300)}1; }`).diagnostics.some((d) => d.code === 'S002')).toBe(true);
  });
  it('never throws on arbitrary input', () => {
    for (const s of ['', '}', '{{{{', 'scene', 'scene "x" {', 'fn (', 'data x: List<', '"\\u{110000}"', '#', '1e10', 'scene "s" { repeat i in { } }']) {
      expect(() => compile(s)).not.toThrow();
    }
  });
});

describe('checker', () => {
  const errs = (src: string) => compile(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  const warns = (src: string) => compile(src).diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code);
  it('parses but fails type checking as a separate stage', () => {
    const c = compile('scene "s" { circle(x: "a", y: 1, radius: 2); }');
    expect(c.stages.map((s) => [s.stage, s.ok])).toEqual([['lex+parse', true], ['check', false]]);
  });
  it('resolves lexical scopes and shadowing', () => {
    expect(errs('scene "s" { if true { let a = 1; } circle(x: a, y: 1, radius: 1); }')).toEqual(['C001']);
    expect(warns('scene "s" { let a = 1; if true { let a = 2; circle(x: a, y: 1, radius: 1); } circle(x: a, y: 1, radius: 1); }')).toEqual(['W001']);
    expect(errs('scene "s" { let a = 1; let a = 2; circle(x: a, y: 1, radius: 1); }')).toEqual(['C007']);
  });
  it('enforces immutability, purity and the absence of recursion', () => {
    expect(errs('scene "s" { let a = 1; a = 2; }')).toContain('C006');
    expect(errs('scene "s" { repeat i in 0..3 { i = 2; } }')).toContain('C006');
    expect(errs('fn f(x: Number) -> Number { circle(x: x, y: 1, radius: 1); return x; } scene "s" {}')).toContain('C011');
    expect(errs('fn f(x: Number) -> Number { return g(x); } fn g(x: Number) -> Number { return f(x); } scene "s" {}')).toEqual(['C012']);
    expect(errs('fn f(x: Number) -> Number { return time; } scene "s" {}')).toEqual(['C001']);
  });
  it('checks definite return and flags unreachable code', () => {
    expect(errs('fn f(x: Number) -> Number { if x > 0 { return 1; } } scene "s" {}')).toEqual(['C009']);
    expect(errs('fn f(x: Number) -> Number { if x > 0 { return 1; } else { return 2; } } scene "s" { circle(x: f(1), y: 1, radius: 1); }')).toEqual([]);
    expect(warns('fn f(x: Number) -> Number { return 1; return 2; } scene "s" { circle(x: f(1), y: 1, radius: 1); }')).toEqual(['W002']);
  });
  it('types operators, calls, lists, fields and named arguments', () => {
    expect(errs('scene "s" { let a = 1 + "x"; }')).toEqual(['C002']);
    expect(errs('scene "s" { let a = "x" + "y"; text(x: 1, y: 1, value: a); }')).toEqual([]);
    expect(errs('scene "s" { let a = [1, "x"]; }')).toEqual(['C002']);
    expect(errs('scene "s" { let a = []; }')).toEqual(['C013']);
    expect(errs('scene "s" { let a: List<Number> = []; circle(x: len(a), y: 1, radius: 1); }')).toEqual([]);
    expect(errs('scene "s" { let p = point(1, 2); circle(x: p.z, y: 1, radius: 1); }')).toEqual(['C018']);
    expect(errs('scene "s" { circle(x: 1, y: 1); }')).toEqual(['C005']);
    expect(errs('scene "s" { circle(x: 1, y: 1, radius: 2, colour: #000000); }')).toEqual(['C004']);
    expect(errs('scene "s" { blob(x: 1); }')).toEqual(['C008']);
    expect(errs('scene "s" { let v = sin(1, 2); }')).toEqual(['C003']);
    expect(errs('scene "s" { let v = #000000 == 1; }')).toEqual(['C002']);
    expect(errs('scene "s" { let sin = 2; }')).toEqual(['C017']);
    expect(errs('scene "s" size 0 x 10 frames 999 {}')).toEqual(['C019', 'C019']);
  });
  it('records a type derivation trace for every expression', () => {
    const c = compile('scene "s" { let a = 1 + 2; circle(x: a, y: 1, radius: 1); }');
    expect(c.check!.trace.map((t) => t.rule)).toContain('Number + Number → Number');
    expect(c.check!.trace.find((t) => t.rule.startsWith('let "a"'))).toBeTruthy();
  });
});

describe('failure gallery (curated corpus)', () => {
  for (const f of failures().filter((x) => x.expect.kind === 'compile')) {
    it(`${f.name} → ${f.expect.code} at ${f.expect.line}:${f.expect.col}`, () => {
      const c = compile(f.source);
      expect(c.ok).toBe(false);
      const first = c.diagnostics.find((d) => d.severity === 'error')!;
      expect(`${first.code}@${first.span.line}:${first.span.col}`).toBe(`${f.expect.code}@${f.expect.line}:${f.expect.col}`);
    });
  }
  it('every diagnostic code emitted by the corpus is documented', () => {
    for (const f of failures()) if (f.expect.kind === 'compile') expect(DIAGNOSTIC_CODES[f.expect.code]).toBeTruthy();
  });
});

describe('check() is total', () => {
  it('handles a program with every kind of error without throwing', () => {
    const p = parse('fn f(a: Number) -> String { return a; } scene "s" { var v = q; v = "x"; repeat i in true { circle(x: f(1), y: [1][0], radius: #000000.r); } }').program!;
    expect(() => check(p)).not.toThrow();
  });
});
