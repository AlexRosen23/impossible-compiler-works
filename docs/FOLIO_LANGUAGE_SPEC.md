# FOLIO Language Specification

Grammar version: `folio-grammar/0.1` (`GRAMMAR_VERSION` in `core/version.ts`). Compiler version `0.1.0`.

This document is normative for FOLIO 0.1 as implemented in `core/`. Where this text and the code disagree, the
code is what runs; the disagreement is a documentation bug. Every rule below cites the module that implements it.

FOLIO is a small, statically typed, pure language for data-driven diagrams and frame-based animations. A program
is one file containing function declarations, dataset declarations and exactly one scene. Running a program
evaluates the scene body once per frame and records the drawing commands it issues. There is no I/O, no clock,
no randomness, no recursion and no unbounded loop.

Contents

1. Lexical grammar
2. Program structure
3. Syntactic grammar (EBNF)
4. Types
5. Names, scopes and shadowing
6. Predeclared names
7. Built-in functions
8. Drawing primitives and `group`
9. Evaluation semantics
10. Frames and time
11. Datasets and fixtures
12. Runtime faults
13. Limits

---

## 1. Lexical grammar (`core/lexer.ts`)

Source text is a JavaScript string. Positions are UTF-16 code-unit offsets; `line` and `col` are 1-based and
`col` counts UTF-16 code units. The lexer never throws: problems become `L`-coded diagnostics plus an `error`
token, and lexing continues.

### 1.1 Whitespace and comments

| Form | Rule |
|---|---|
| Whitespace | space, tab, carriage return, line feed. Nothing else (a non-ASCII space is `L001`). |
| Line comment | `//` up to (not including) the next line feed. |
| Block comment | `/*` ... `*/`. Not nested: the first `*/` closes it. An unclosed block comment is `L005`. |

Comments are kept as `comment` tokens (for editor colouring) and removed before parsing.

### 1.2 Token kinds

`number`, `string`, `color`, `ident`, `keyword`, `type`, `punct`, `comment`, `error`, `eof`.

### 1.3 Identifiers and reserved words

```
ident-start = "a".."z" | "A".."Z" | "_" ;
ident-part  = ident-start | "0".."9" ;
identifier  = ident-start { ident-part } ;
```

Only ASCII letters are identifier characters. A word is classified in this order:

| Class | Words |
|---|---|
| Keywords | `scene fn let var if else repeat in return assert true false and or not data group` |
| Type names | `Number Boolean String Color Point List` |
| Identifiers | everything else |

Keywords and type names can never be used as names (the parser reports `P001` with the hint that the word is
reserved).

Contextual words: `size`, `frames`, `background` and `from` are ordinary identifiers. They have special meaning
only in a scene header (`size`, `frames`, `background`) and in a data declaration (`from`). The word `x` in
`size 800 x 480` is likewise an ordinary identifier. All of these remain usable as variable and argument names
(`text(..., size: 9)`, `let from = 3;` are valid; tested in `tests/frontend.test.ts`).

### 1.4 Number literals

```
number = digit { digit } [ "." digit { digit } ] ;
```

- Decimal only. No sign (a leading `-` is the unary minus operator), no exponent (`1e3` is `L007`), no hex,
  no leading dot (`.5` lexes as `.` then `5`), no trailing dot (`1.` lexes as `1` then `.`).
- A number immediately followed by an identifier character is `L007` (so `size 800x480` is an error; write
  `size 800 x 480`).
- A literal whose value is not finite (for example several hundred digits) is `L007`.
- `0..5` lexes as `0`, `..`, `5`, because a `.` is consumed as a decimal point only when a digit follows it.

### 1.5 String literals

```
string = '"' { char | escape } '"' ;
escape = "\n" | "\t" | '\"' | "\\" | "\u{" hex{1,6} "}" ;
```

- Strings are single-line: a line feed before the closing quote is `L002`. A raw tab or carriage return inside
  a string is accepted as itself.
- `\u{...}` takes 1 to 6 hex digits naming a Unicode scalar value: at most `10FFFF`, and not a surrogate
  (`D800`..`DFFF`). Anything else is `L003`. Any other escape (`\q`, `\r`, ...) is `L003`.
- The decoded length, in UTF-16 code units, must not exceed `maxStringLength` (1,000); otherwise `L006`.

### 1.6 Colour literals

```
color = "#" hex hex hex hex hex hex [ hex hex ] ;
```

`#RRGGBB` or `#RRGGBBAA`, case-insensitive; the token value is lower-cased. The lexer reads every identifier
character after `#`, so `#12zz99` or `#12` is one invalid token, `L004`. `AA` is alpha (`AA / 255`); without it
alpha is 1.

### 1.7 Punctuation

Longest match first: `..  ->  ==  !=  <=  >=` then `{ } ( ) [ ] , : ; . = < > + - * / %`. There is no `>>` token,
so `List<List<Number>>` lexes; but `List<Number>=` lexes `>=`, so write a space before `=` after a list type.

Any other character is `L001`.

### 1.8 Lexical limits

More than `maxSourceChars` (64,000) characters, or more than `maxTokens` (20,000) tokens, is `S001`. An oversized
source produces no tokens and parsing does not run.

---

## 2. Program structure

A program is a sequence of items in any order:

- zero or more `fn` declarations (pure functions),
- zero or more `data` declarations (read-only datasets bound from fixtures),
- exactly one `scene` declaration. None is `P002` (reported only when there are no other errors); more than one
  is `P003`.

Function and dataset declarations are visible throughout the file regardless of order (the checker collects
their signatures in a first pass, `core/checker.ts`).

Example (`examples/12-fibonacci-steps.folio`):

```
fn fib(n: Number) -> Number {
  if n < 2 {
    return n;
  }
  var a = 0;
  var b = 1;
  repeat k in 1..n {
    let next = a + b;
    a = b;
    b = next;
  }
  return b;
}

scene "Fibonacci Steps" size 800 x 480 background #101013 {
  assert fib(10) == 55, "fib(10) is 55";
  repeat n in 1..15 {
    let h = fib(n) * 0.75;
    rect(x: 40 + n * 50, y: 440 - h, width: 34, height: h, fill: hsl(20 + n * 8, 0.5, 0.55));
    text(x: 42 + n * 50, y: 462, value: str(fib(n)), size: 10, fill: #f0eadd);
  }
}
```

---

## 3. Syntactic grammar (`core/parser.ts`)

The parser is hand-written recursive descent with one method per production below. Terminals in double quotes
are keywords or punctuation; `IDENT`, `NUMBER`, `STRING`, `COLOR` are token kinds; `"size"` etc. written in
double quotes inside `scene-option` and `data-decl` are contextual identifiers, not keywords.

```ebnf
program      = { item } EOF ;
item         = fn-decl | data-decl | scene-decl ;

fn-decl      = "fn" IDENT "(" [ param { "," param } [ "," ] ] ")" "->" type block ;
param        = IDENT ":" type ;
data-decl    = "data" IDENT ":" type "from" STRING ";" ;
scene-decl   = "scene" STRING { scene-option } block ;
scene-option = "size" NUMBER "x" NUMBER
             | "frames" NUMBER
             | "background" COLOR ;

type         = "Number" | "Boolean" | "String" | "Color" | "Point"
             | "List" "<" type ">" ;

block        = "{" { stmt } "}" ;
stmt         = let-stmt | if-stmt | repeat-stmt | return-stmt | assert-stmt
             | group-stmt | draw-stmt | assign-stmt ;
let-stmt     = ( "let" | "var" ) IDENT [ ":" type ] "=" expr ";" ;
assign-stmt  = IDENT "=" expr ";" ;                  (* IDENT followed by "=" *)
draw-stmt    = IDENT named-args ";" ;                (* IDENT followed by "(" *)
group-stmt   = "group" named-args block ;
named-args   = "(" [ named-arg { "," named-arg } [ "," ] ] ")" ;
named-arg    = IDENT ":" expr ;
if-stmt      = "if" expr block [ "else" ( if-stmt | block ) ] ;
repeat-stmt  = "repeat" IDENT "in" expr [ ".." expr ] block ;
return-stmt  = "return" expr ";" ;
assert-stmt  = "assert" expr [ "," STRING ] ";" ;

expr         = or-expr ;
or-expr      = and-expr { "or" and-expr } ;
and-expr     = eq-expr { "and" eq-expr } ;
eq-expr      = cmp-expr [ ( "==" | "!=" ) cmp-expr ] ;          (* non-associative *)
cmp-expr     = add-expr [ ( "<" | "<=" | ">" | ">=" ) add-expr ] ; (* non-associative *)
add-expr     = mul-expr { ( "+" | "-" ) mul-expr } ;
mul-expr     = unary { ( "*" | "/" | "%" ) unary } ;
unary        = ( "-" | "not" ) unary | postfix ;
postfix      = primary { "[" expr "]" | "." IDENT } ;
primary      = NUMBER | STRING | COLOR | "true" | "false"
             | IDENT "(" [ expr { "," expr } [ "," ] ] ")"   (* call *)
             | IDENT                                         (* name *)
             | "(" expr ")"
             | "[" [ expr { "," expr } [ "," ] ] "]" ;       (* list literal *)
```

Notes that follow directly from the parser:

- Trailing commas are accepted in parameter lists, named-argument lists, call arguments and list literals.
  Empty lists `()` and `[]` are syntactically valid.
- A statement that starts with an identifier is a drawing call if the next token is `(` and an assignment if it
  is `=`; anything else is `P001` (`expected "(" (a drawing call) or "=" (an assignment)`). There are no
  expression statements: `f(1);` is parsed as a drawing call and then fails because drawing calls take named
  arguments.
- A call's callee is always a bare identifier. Calls take positional arguments only; writing `name: value` in a
  call is `P001` with the hint that named arguments are only for drawing calls.
- In `repeat`, the first expression is a full expression; if `..` follows, it is a range start and the second
  expression is the end, otherwise it is the iterable. `..` is not an expression operator.
- `else if` chains are nested `if` statements in the `else` position.
- The scene options may appear in any order. Repeating one is a check-time error (`C019`), not a parse error.
- Parenthesised expressions produce no AST node of their own.

### 3.1 Operator precedence and associativity

| Level (low to high) | Operators | Associativity |
|---|---|---|
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `==` `!=` | none: `a == b == c` is `P001` ("comparisons do not chain") |
| 4 | `<` `<=` `>` `>=` | none: `a < b < c` is `P001` |
| 5 | `+` `-` | left |
| 6 | `*` `/` `%` | left |
| 7 | unary `-`, `not` | prefix, right (`- -x`) |
| 8 | postfix `[index]`, `.field` | left |

Consequences: unary operators bind tighter than every binary operator, so `not a == b` is `(not a) == b` and
`-a * b` is `(-a) * b`; postfix binds tighter than unary, so `-xs[0]` is `-(xs[0])`.

### 3.2 Error recovery

- A syntax error is reported as `P001: expected X, found Y`, where X lists the alternatives the parser could
  accept at that point.
- Recovery is panic mode: skip to just after the next `;`, or stop before a `}` or a statement/item keyword
  (`let var if repeat return assert fn scene data group`), then continue. Several errors can be reported in one
  pass (see `tests/frontend.test.ts`, "recovers to report several errors").
- If the failing token is itself a lexer `error` token, no extra `P001` is stacked on it.
- After `maxErrors` (50) syntax errors the parser stops with `P005`.
- Expression nesting deeper than `maxExprDepth` (200), counting both parenthesised and unary nesting, is `S002`
  and stops the parse.
- A program with more than `maxAstNodes` (20,000) nodes is `S002`.
- Block nesting deeper than `maxExprDepth` (200), counting every block including the function or scene body,
  is `S002` ("blocks nested more than 200 levels") and stops the parse.

---

## 4. Types (`core/checker.ts`, `core/values.ts`)

| Type | Values | Notes |
|---|---|---|
| `Number` | IEEE-754 double | Always finite at run time: every arithmetic and built-in result is checked (fault `R001`). `-0` exists and compares equal to `0`. |
| `Boolean` | `true`, `false` | |
| `String` | sequence of UTF-16 code units | Length limit 1,000 code units (`L006` for literals, `R009` at run time). |
| `Color` | RGBA | `r`, `g`, `b` are integers 0 to 255; `a` is in [0, 1], quantized to multiples of 1/255. |
| `Point` | pair of Numbers | fields `x`, `y`. |
| `List<T>` | immutable sequence of `T` | `T` must be one of the five types above. `List<List<T>>` is `C015`. |

There are no user-defined types, no tuples, no null literal, no `Void` values, and no implicit conversions
(numbers become strings only through `str` or `fmt`). Type annotations are optional on `let`/`var`; parameters
and function results must be annotated. The full typing rules are in `TYPE_SYSTEM.md`.

Fields:

| Type | Fields (all `Number`) |
|---|---|
| `Point` | `x`, `y` |
| `Color` | `r`, `g`, `b` (0 to 255), `a` (0 to 1) |

Equality (`==`, `!=`) is defined for `Number`, `Boolean`, `String` and `Color` (component-wise), with both
operands of the same type. `Point` and `List` values cannot be compared.

---

## 5. Names, scopes and shadowing (`core/checker.ts`)

Scopes are lexical and nested:

| Scope | Contains | Parent |
|---|---|---|
| global | `PI`, `TAU`, every `fn`, every `data` | none |
| fn | the parameters and the top-level statements of the body (same scope) | global |
| scene | `WIDTH`, `HEIGHT`, `time`, `frame` and the top-level statements of the scene body (same scope) | global |
| block | statements of an `if`/`else` branch or a `group` body | enclosing scope |
| loop | the loop variable and the statements of the loop body (same scope) | enclosing scope |

Rules:

1. A name is visible from its declaration to the end of its scope. Using a name before its `let` in the same
   block is `C001`.
2. Declaring a name twice in the same scope is `C007`. Because a function's parameters share a scope with its
   body, `fn f(x: Number) ... { let x = 1; ... }` is `C007`; likewise a loop body cannot redeclare its loop
   variable.
3. Two `fn`/`data` declarations with the same name (in any combination) are `C020`.
4. Built-in function names, primitive names (`circle rect line path text`), `PI`, `TAU`, `WIDTH`, `HEIGHT`,
   `time` and `frame` are reserved: declaring any of them (as a function, dataset, parameter, `let`, `var` or
   loop variable) is `C017`.
5. A `let`, `var`, parameter or loop variable that shadows a binding in an enclosing scope is allowed, with
   warning `W001`, unless the outer binding is a function, dataset or constant (no warning then).
6. Calls resolve by name against the built-in table first and then the function table, never against local
   bindings. A local `let f = 3;` therefore does not hide `fn f`: `f(2)` still calls the function, and `f`
   alone still reads the local.
7. `let` bindings are immutable (`C006` on assignment). `var` bindings are mutable. Parameters, loop variables,
   datasets, functions, constants and scene inputs cannot be assigned (`C006`).
8. A `let` or `var` that is never read produces `W003` unless its name starts with `_`. Assignment is not a
   read.

---

## 6. Predeclared names

| Name | Type | Value | Visible in |
|---|---|---|---|
| `PI` | Number | `Math.PI` | everywhere (global scope) |
| `TAU` | Number | `2 * Math.PI` | everywhere |
| `WIDTH` | Number | canvas width from `size` (default 800) | scene only |
| `HEIGHT` | Number | canvas height from `size` (default 480) | scene only |
| `time` | Number | `frame / frames`, in [0, 1) | scene only |
| `frame` | Number | current frame index, 0-based | scene only |

Functions cannot see `WIDTH`, `HEIGHT`, `time` or `frame`; using one is `C001` with the hint "functions cannot see
scene inputs; pass X as a parameter". This is what makes functions pure functions of their arguments (plus
constants and datasets).

---

## 7. Built-in functions (`core/builtins.ts`)

All built-ins are pure. No built-in performs I/O or reads a clock or random source. Every numeric result is
checked for finiteness (`R001`), every string result for length (`R009`), and both coordinates of a `Point`
result for finiteness (`R001`).

| Signature | Semantics |
|---|---|
| `sin(x: Number) -> Number` | `Math.sin`, radians |
| `cos(x: Number) -> Number` | `Math.cos`, radians |
| `tan(x: Number) -> Number` | `Math.tan`, radians |
| `sqrt(x: Number) -> Number` | `R001` for `x < 0` (NaN) |
| `abs(x: Number) -> Number` | `Math.abs` |
| `floor(x: Number) -> Number` | `Math.floor` |
| `ceil(x: Number) -> Number` | `Math.ceil` |
| `round(x: Number) -> Number` | `Math.round`: halves round toward +infinity |
| `sign(x: Number) -> Number` | `Math.sign` |
| `exp(x: Number) -> Number` | `R001` on overflow |
| `log(x: Number) -> Number` | natural log; `R001` for `x <= 0` |
| `min(a: Number, b: Number) -> Number` | |
| `max(a: Number, b: Number) -> Number` | |
| `pow(a: Number, b: Number) -> Number` | `R001` if the result is not finite |
| `atan2(y: Number, x: Number) -> Number` | |
| `noise(a: Number, b: Number) -> Number` | `fract(sin(a * 12.9898 + b * 78.233) * 43758.5453)`, a deterministic hash in [0, 1); `R001` if the inner product overflows |
| `clamp(x: Number, lo: Number, hi: Number) -> Number` | `min(max(x, lo), hi)` |
| `lerp(a: Number, b: Number, t: Number) -> Number` | `a + (b - a) * t`, `t` not clamped |
| `point(x: Number, y: Number) -> Point` | |
| `dist(a: Point, b: Point) -> Number` | `Math.hypot` of the difference |
| `rgb(r: Number, g: Number, b: Number) -> Color` | components rounded and clamped to 0..255, alpha 1 |
| `rgba(r: Number, g: Number, b: Number, a: Number) -> Color` | as `rgb`; `a` clamped to [0, 1] and quantized to /255 |
| `hsl(h: Number, s: Number, l: Number) -> Color` | `h` in degrees (wrapped), `s` and `l` clamped to [0, 1] |
| `mix(a: Color, b: Color, t: Number) -> Color` | component-wise linear blend, `t` clamped to [0, 1] |
| `alpha(c: Color, a: Number) -> Color` | replaces alpha (clamped, quantized) |
| `len(xs: List<T>) -> Number` | the only polymorphic function: any list element type |
| `str(x: Number) -> String` | JavaScript `String(x)` (may produce exponent notation, e.g. for very large values) |
| `fmt(x: Number, digits: Number) -> String` | `x.toFixed(d)` with `d = round(digits)` clamped to 0..6 |

Built-in names are reserved (section 5, rule 4).

---

## 8. Drawing primitives and `group` (`core/primitives.ts`)

Drawing statements use named arguments. Arguments may be written in any order; each optional parameter has a
default. `#f0eadd` is the default "cream" colour; `none` means no fill or stroke.

| Primitive | Required | Optional (default) |
|---|---|---|
| `circle` | `x: Number`, `y: Number`, `radius: Number` (non-negative) | `fill: Color` (`#f0eadd`), `stroke: Color` (none), `strokeWidth: Number` (1, non-negative) |
| `rect` | `x`, `y`, `width` (non-negative), `height` (non-negative): Number | `fill` (`#f0eadd`), `stroke` (none), `strokeWidth` (1, non-negative), `corner: Number` (0, non-negative) |
| `line` | `from: Point`, `to: Point` | `stroke: Color` (`#f0eadd`), `strokeWidth` (1, non-negative) |
| `path` | `points: List<Point>` | `fill: Color` (none), `stroke: Color` (`#f0eadd`), `strokeWidth` (1, non-negative), `closed: Boolean` (false) |
| `text` | `x: Number`, `y: Number`, `value: String` | `size: Number` (14, non-negative), `fill: Color` (`#f0eadd`) |

`group(translate: Point = point(0, 0), rotate: Number = 0, scale: Number = 1, opacity: Number = 1) { ... }`

- `rotate` is in degrees. `scale` is not range-checked (zero and negative values are accepted). `opacity` is
  clamped to [0, 1].
- The group's local transform is the matrix `[c*s, sn*s, -sn*s, c*s, tx, ty]` with `c = cos(rotate)`,
  `sn = sin(rotate)`, `s = scale`, `(tx, ty) = translate`; it is composed with the enclosing group's matrix
  (parent times local). Opacity multiplies the enclosing opacity.
- Groups may be nested 32 deep (`maxGroupDepth`); the 33rd nested group faults `R011`.

Rules checked statically: unknown argument or the same argument twice is `C004`; a missing required argument is
`C005`; a wrong argument type is `C002`; an unknown primitive is `C008`; drawing or `group` inside a function is
`C011`.

Rules checked at run time (in the shared scene builder, `core/scene.ts`): a negative value for a parameter marked
non-negative faults `R010`; the 10,001st draw in one frame faults `R005`; a `path` with more than
`maxFixtureLength` (10,000) points faults `R005`.

### 8.1 Scene output (`core/scene.ts`)

Each draw appends one command `{ k, a, m, o }` to the current frame:

- `k`: primitive name.
- `a`: every parameter of the primitive in declared order, after defaults. Numbers are quantized to 1e-4 with
  `-0` written as `0`; colours are `#rrggbbaa` strings or `null`; a `Point` is `[[x, y]]`; a `List<Point>` is
  `[[x, y], ...]`; booleans and strings as is.
- `m`: the accumulated group matrix (quantized). `o`: the accumulated opacity (quantized).

The scene output is `{ format: "folio-scene/0.1", title, width, height, background, frames: [{ index, time,
cmds }] }`. Two runs drew the same thing exactly when the SHA-256 of the canonical JSON of their outputs is
equal (`sceneHash`).

---

## 9. Evaluation semantics

The reference interpreter (`core/interpreter.ts`) is the executable definition of these rules; the compiled
pipeline must match it (see `OPTIMIZATION_CORRECTNESS.md`).

### 9.1 Statements

Statements run in order.

| Statement | Semantics |
|---|---|
| `let`/`var` | Evaluate the initializer, then bind. Evaluation is strict: an unused binding is still evaluated, and if it faults the program faults. |
| assignment | Evaluate the value, then store it in the `var`. |
| `if` | Evaluate the condition; run the `then` block or the `else` part (each block is a new scope). |
| `repeat i in a..b` | Evaluate `a`, then `b`, once. If either is not a whole number, fault `R008`. Then for `i = a, a+1, ...` while `i < b` run the body (half-open; no iterations when `a >= b`). Each iteration first counts against the per-frame iteration limit (`R004`). The loop variable is immutable and fresh per iteration. |
| `repeat x in xs` | Evaluate `xs` once; run the body once per element, in order, with `x` bound to the element. Each iteration counts against the iteration limit. |
| `return e` | Evaluate `e` and leave the function. Only in functions. |
| `assert c [, "msg"]` | Evaluate `c`; if false, fault `R003` with the message (or `assertion failed`). |
| drawing call | Evaluate the written named arguments in the order written, fill in defaults, then draw. |
| `group(...) { }` | Evaluate the written named arguments in the order written, fill in defaults, push the transform (`R011` if too deep), run the body, pop. |

### 9.2 Expressions

- Operands are evaluated left to right; every operand is evaluated before the operator applies.
- `and` and `or` short-circuit: the right operand is evaluated only if the left does not decide the result.
- Call arguments are evaluated left to right, then the call happens.
- Index: the list, then the index. The index must be a whole number in `0 .. len-1`, otherwise `R002`.
- `+ - * / %` on Numbers fault `R001` if the result is not finite (division by zero, overflow, `0/0`, `x % 0`).
  `%` is JavaScript's remainder (sign of the dividend). Unary `-` cannot produce a non-finite value.
- `+` on Strings concatenates; a result over 1,000 code units faults `R009`.
- Comparisons are IEEE comparisons on finite numbers.
- Function calls bind arguments to parameters and run the body until `return`. Functions are pure: they cannot
  draw, cannot see scene inputs, and cannot assign anything outside their own `var`s.

### 9.3 Runtime values are immutable

Lists, points and colours are immutable. There is no way to append to or modify a list; `var` rebinding replaces
the whole value.

---

## 10. Frames and time

- `frames N` sets the number of frames (default 1, allowed 1 to 240, otherwise `C019`).
- For each frame index `f` in `0 .. N-1`, the scene body is evaluated from scratch with `frame = f` and
  `time = f / N`, so `time` is in [0, 1). No state carries over between frames.
- The iteration limit (`R004`), draw limit (`R005`) and VM fuel (`R006`) are per frame.
- Execution stops at the first frame that faults. The output keeps every earlier frame plus the commands the
  faulting frame drew before the fault, and records the fault code, message, source span and frame index.
- `size W x H` sets the canvas (default 800 x 480; each a whole number 1 to 4096, otherwise `C019`).
  `background #RRGGBB[AA]` sets the background (default `#101013`).

---

## 11. Datasets and fixtures (`core/fixtures.ts`)

```
data rain: List<Number> from "rainfall";
```

- The declared type must be a list type (`C002` otherwise).
- The string after `from` is a fixture name, not a path. It must match `^[a-z][a-z0-9_-]{0,63}$` (`F003`).
- The host supplies a fixture table (name to JSON value). The CLI and tests load `examples/fixtures/*.json`;
  the server loads the same directory and also accepts validated inline tables.
- Missing fixture: `F001`. Not a list, or an element of the wrong shape: `F002`. More than 10,000 items: `F004`.
- Element rules: `Number` needs a finite JSON number; `String` a string of at most 1,000 code units; `Boolean` a
  JSON boolean; `Color` a `"#RRGGBB"` or `"#RRGGBBAA"` string; `Point` a two-element array of finite numbers.
- Datasets are frozen and visible in every function and in the scene.

---

## 12. Runtime faults (`core/values.ts`)

A fault stops the current frame and the run. "Both" means both executors (VM and reference interpreter)
raise it under the same conditions, with the same code and source span.

| Code | Meaning | Raised when | Raised by |
|---|---|---|---|
| `R001` | non-finite number | an arithmetic operator (`+ - * / %`) or built-in returns NaN or plus/minus infinity, or `point` receives such a coordinate | both |
| `R002` | bad list index | an index is not a whole number or is outside `0 .. len-1` | both |
| `R003` | assertion failed | `assert` evaluates to false | both |
| `R004` | iteration limit | the 100,001st loop iteration in one frame (all loops in the scene and in called functions count) | both |
| `R005` | drawing limit | the 10,001st draw in one frame, or a `path` with more than 10,000 points (unreachable in practice: lists come from literals of at most 1,000 items or fixtures of at most 10,000) | both (shared scene builder) |
| `R006` | fuel exhausted | the VM would execute more than 20,000,000 instructions in one frame | VM only |
| `R007` | call depth / stack | a call is made while 64 VM frames are already active, or the operand stack exceeds 1,024 values | VM only; not reachable from a checked, verified program (call depth is enforced statically by `S004`, stack depth statically by the bytecode verifier) |
| `R008` | bad range | a range bound is not a whole number | both |
| `R009` | string too long | concatenation or a built-in produces a string over 1,000 code units | both |
| `R010` | negative size | a non-negative primitive argument (radius, width, height, strokeWidth, corner, text size) is negative | both (shared scene builder) |
| `R011` | groups too deep | a 33rd nested `group` is entered | both (shared scene builder) |
| `R012` | invalid bytecode at run time | `HALT` inside a function, `RET` with no caller, or an unknown opcode | VM only; not reachable from verified compiler output |

`R006` and `R007` are not part of the language semantics; the reference interpreter has neither limit.

- Call depth is part of static checking: the longest chain of calls starting in the scene, counting the scene's
  own frame, must be at most `maxCallDepth` (64), otherwise `S004` (so at most 63 nested function calls). The
  checker therefore rejects every program whose calls could hit the VM's call-depth limit, and both executors
  accept exactly the same programs.
- The operand stack is bounded statically by the bytecode verifier (`maxStack`), so its run-time check does not
  fire for verified compiler output.
- Fuel remains a VM-only machine limit. A legal program can exhaust it where the reference interpreter finishes:
  for example a loop of up to 100,000 iterations whose body executes more than about 200 VM instructions. A run
  receipt then records `oracle.status: "vm-resource-limit"` rather than `"diverge"` (`COMPILER_PIPELINE.md`
  section 5).

---

## 13. Limits (`core/limits.ts`, `DEFAULT_LIMITS`)

| Limit | Default | Enforced by | Effect | Kind |
|---|---|---|---|---|
| `maxSourceChars` | 64,000 | lexer | `S001` | compile-time |
| `maxTokens` | 20,000 | lexer | `S001` | compile-time |
| `maxAstNodes` | 20,000 | parser | `S002` | compile-time |
| `maxExprDepth` | 200 | parser (expression nesting and block nesting) | `S002` | compile-time |
| `maxErrors` | 50 | parser | `P005` | compile-time |
| `maxSymbols` | 2,000 | checker | `S003` | compile-time |
| `maxListLiteral` | 1,000 | checker; bytecode verifier (`LIST` operand) | `C016` | compile-time |
| `maxFrames` | 240 | checker; scene validator | `C019` | compile-time |
| `maxCanvas` | 4,096 | checker; scene validator | `C019` | compile-time |
| `maxFixtureLength` | 10,000 | fixture loader; scene builder (`path`) | `F004`; `R005` | compile-time and semantic |
| `maxStringLength` | 1,000 | lexer; fixture loader; both executors | `L006`; `F002`; `R009` | compile-time and semantic |
| `maxIterationsPerFrame` | 100,000 | both executors | `R004` | semantic |
| `maxDrawsPerFrame` | 10,000 | shared scene builder | `R005` | semantic |
| `maxGroupDepth` | 32 | shared scene builder | `R011` | semantic |
| `maxCallDepth` | 64 | checker (longest call chain from the scene, scene frame included); VM (dynamic) | `S004`; `R007` | compile-time rule mirroring a VM limit |
| `fuelPerFrame` | 20,000,000 | VM | `R006` | VM-only machine limit |
| `maxStack` | 1,024 | bytecode verifier (static), VM (dynamic) | verify error; `R007` | VM-only machine limit |
| `maxBytecodeInstrs` | 200,000 | bytecode verifier | verify error | VM-only machine limit |

"Semantic" limits are enforced identically by both executors, so a program that hits one fails the same way in
both (this is tested for `R004` and `R005` in `tests/differential.test.ts`). The call-depth limit is enforced
statically, so it never separates the executors. Fuel is the one VM-only limit a checked program can reach; see
the end of section 12.
