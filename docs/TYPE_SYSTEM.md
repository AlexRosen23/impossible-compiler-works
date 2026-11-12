# FOLIO Type System and Static Semantics

Implementation: `core/checker.ts` (names, types, definite return, reachability, recursion, scene options),
`core/fixtures.ts` (dataset binding), `core/diagnostics.ts` (codes). Language reference:
`FOLIO_LANGUAGE_SPEC.md`.

Checking is a separate stage from parsing: a program can parse and still fail here (tested in
`tests/frontend.test.ts`, "parses but fails type checking as a separate stage"). The checker never throws on a
parsed program, however broken (`check() is total` test); it collects every error rather than stopping at the
first.

## 1. Types

Types are canonical strings: `Number`, `Boolean`, `String`, `Color`, `Point`, `List<T>` where `T` is one of the
first five. Two internal types never appear in source: `Void` and `Error`. `Error` is a poison type: an
expression that failed to type gets `Error`, and any rule that sees an `Error` operand produces `Error` without
reporting a second diagnostic. This is what keeps one mistake from cascading.

The type system is monomorphic with one exception: `len` accepts `List<T>` for any `T`. There is no subtyping,
no implicit conversion, no inference across functions (parameters and results are annotated) and no generic
user functions.

Typing is mostly bottom-up. The single place where context flows downward is the empty list literal `[]`: it
takes its element type from the expected type at that position (a `let` annotation, the target of an assignment,
a parameter type, a named-argument type or a function's return type). Without such context it is `C013`.

## 2. Expression rules

`e : T` means the checker records type `T` for expression `e` and adds a derivation step (the `rule` text in
quotes is what the Type Observatory trace shows; see `CheckResult.trace`).

| Form | Rule | Result | Errors |
|---|---|---|---|
| number literal | always | `Number` | none |
| string literal | always | `String` | none |
| colour literal | always | `Color` | none |
| `true` / `false` | always | `Boolean` | none |
| name `x` | `x` resolves to a let, var, param, loop variable, dataset, constant or scene input of type `T` | `T` | `C001` undeclared (with a "did you mean" hint for names within edit distance 2); `C014` if `x` names a function |
| `-e` | `e : Number` | `Number` | `C014` otherwise |
| `not e` | `e : Boolean` | `Boolean` | `C014` otherwise |
| `a + b` | both `Number`, or both `String` (concatenation) | `Number` or `String` | `C002` otherwise (hint: convert with `str` or `fmt`) |
| `a - b`, `a * b`, `a / b`, `a % b` | both `Number` | `Number` | `C002` |
| `a < b`, `<=`, `>`, `>=` | both `Number` | `Boolean` | `C002` |
| `a == b`, `a != b` | same type, one of `Number Boolean String Color` | `Boolean` | `C002` (so `Point == Point` and list equality are errors) |
| `a and b`, `a or b` | both `Boolean` | `Boolean` | `C002` |
| `f(a1, ..., an)` built-in | arity matches; each `ai` has the parameter type; `len`'s argument is any `List<T>` | declared result | `C003` arity (result is still the declared type, to avoid cascades); `C002` per bad argument (result `Error`) |
| `f(a1, ..., an)` user function | as above, against the declared signature | declared result | `C003`, `C002` |
| `f(...)` where `f` is not a function | | `Error` | `C008` if `f` is a drawing primitive ("draws a shape and has no value") or a local binding; `C001` if unknown |
| `xs[i]` | `xs : List<T>`, `i : Number` | `T` | `C014` if `xs` is not a list; `C002` if `i` is not a Number |
| `p.f` | `p : Point` and `f` in `x y`, or `p : Color` and `f` in `r g b a` | `Number` | `C018` |
| `[e1, ..., en]` | `n >= 1`; `e1 : T`; every `ei : T`; `T` is not a list | `List<T>` | `C002` mixed item types; `C015` nested list; `C016` more than 1,000 items |
| `[]` | expected type `List<T>` from context | `List<T>` | `C013` without context |

Calls are resolved by name against the built-in table, then the function table. Local bindings never hide a
function for the purpose of a call (`FOLIO_LANGUAGE_SPEC.md` section 5, rule 6).

## 3. Statement rules

| Statement | Rule | Errors |
|---|---|---|
| `let x: T = e;` / `var x: T = e;` | `e` is checked with expected type `T`; `e : T` | `C002` mismatch; `C017` reserved name; `C007` duplicate in scope; `W001` shadowing |
| `let x = e;` / `var x = e;` | `x` gets the type of `e` | `C013` for a bare `[]`; as above |
| `x = e;` | `x` is a `var` of type `T`; `e : T` (checked with expected type `T`) | `C001` undeclared; `C006` not a `var`; `C002` mismatch |
| `if c { } else { }` | `c : Boolean`; each branch is a new block scope | `C002` |
| `repeat i in a..b { }` | `a : Number`, `b : Number`; `i : Number` in a new loop scope | `C002` |
| `repeat x in xs { }` | `xs : List<T>`; `x : T` in a new loop scope | `C002` if `xs` is not a list |
| `return e;` | inside a function with result `T`; `e : T` | `C010` outside a function; `C002` mismatch |
| `assert c [, "m"];` | `c : Boolean` | `C002` |
| `prim(name: e, ...);` | `prim` is a drawing primitive; each named argument exists, appears once and has its parameter type; every required argument is present; not inside a function | `C008` not a primitive; `C004` unknown or repeated argument; `C005` missing required argument; `C002` argument type; `C011` inside a function |
| `group(name: e, ...) { }` | as for primitives, against the `group` signature; body is a new block scope | `C004`, `C002`, `C011` |

Declarations:

| Declaration | Rule | Errors |
|---|---|---|
| `fn f(p: T, ...) -> R { }` | signature collected in pass 1 (order-independent); body checked in pass 2; every path must return | `C020` duplicate; `C017` reserved; `C015` nested list type; `C009` missing return; `C012` recursion |
| `data d: List<T> from "name";` | type must be a list | `C002` not a list; `C015`; `C020` |
| `scene "t" options { }` | options valid and not repeated | `C019` |

Scene options: `size W x H` with whole numbers 1 to 4,096; `frames N` with a whole number 1 to 240; `background`
any colour literal. A repeated option is `C019`.

## 4. Definite return and unreachable code

The checker computes, for each statement, whether every path through it ends in `return`:

| Statement | Definitely returns when |
|---|---|
| `return` | always (also inside the scene, where it is already `C010`) |
| `if` without `else` | never |
| `if ... else ...` | both the `then` block and the `else` part definitely return (an `else if` chain is checked recursively) |
| `repeat` | never (the body might run zero times) |
| any other statement | never |
| a block | some statement in it definitely returns |

- A function whose body does not definitely return is `C009`, reported on the body.
- In a block, the first statement after one that definitely returns gets `W002` ("can never run"); only one
  `W002` per block.

Because the checker proves definite return, the lowering ends every function with a `halt` terminator that is
unreachable in a checked program (`core/lower.ts`).

## 5. Recursion check

The checker builds a call graph over user functions while checking their bodies (calls from the scene are not
edges, because the scene is not callable). A depth-first search reports any back edge as `C012`, at the name of
the function where the cycle closes, with the cycle in the message (for example `recursion is not allowed:
down → down`). Each cycle is reported once. Direct and mutual recursion are both rejected (tested in
`tests/frontend.test.ts`).

The same property is re-checked twice later as defence in depth: on the IR (`irCallGraphAcyclic` in
`core/irverify.ts`, run in the `lower` stage) and on bytecode (`verifyBytecode` rejects a `CALLF` cycle).

## 6. Warnings versus errors

Warnings (`W` codes) never stop compilation; they are reported with the diagnostics, listed in a run receipt's
`warnings` field as `CODE@line:col`, and do not change the compiled output. Every other code is an error. A
stage fails when it produces at least one error; the pipeline stops at the first failing stage, so for example
lexer errors prevent checking (`COMPILER_PIPELINE.md`).

| Warning | When |
|---|---|
| `W001` | a `let`, `var`, parameter or loop variable shadows a binding of an enclosing scope that is not a function, dataset or constant |
| `W002` | first statement of a block that follows a definitely-returning statement |
| `W003` | a `let` or `var` that is never read and whose name does not start with `_` (assignments do not count as reads) |

## 7. Diagnostic codes

This table lists every code in `DIAGNOSTIC_CODES` (`core/diagnostics.ts`). "Stage" is the `stage` field of the
diagnostic. Runtime faults (`R` codes) are not diagnostics; they are listed in `FOLIO_LANGUAGE_SPEC.md`
section 12.

| Code | Severity | Stage | Meaning | Raised when |
|---|---|---|---|---|
| L001 | error | lex | unexpected character | a character that starts no token (including non-ASCII outside strings and comments) |
| L002 | error | lex | unterminated string | a line feed or end of file before the closing `"` |
| L003 | error | lex | invalid escape in string | an escape other than `\n \t \" \\ \u{...}`, or a `\u{...}` that is not a Unicode scalar value |
| L004 | error | lex | invalid colour literal | `#` not followed by exactly 6 or 8 hex digits |
| L005 | error | lex | unterminated block comment | `/*` without `*/` |
| L006 | error | lex | string literal too long | decoded literal over 1,000 UTF-16 code units |
| L007 | error | lex | invalid number literal | digits followed by identifier characters (`1e3`, `800x480`), or a non-finite value |
| P001 | error | parse | unexpected token | any "expected X, found Y"; also chained comparisons and reserved words used as names |
| P002 | error | parse | missing scene declaration | no `scene` item and no other syntax errors |
| P003 | error | parse | more than one scene declaration | a second `scene` item |
| P004 | error | parse | invalid scene option | listed in the table; the current parser reports bad scene headers as `P001` and never emits `P004` |
| P005 | error | parse | too many syntax errors; parsing stopped | 50 syntax errors reached |
| C001 | error | check | undeclared name | a name, assignment target or callee that resolves to nothing |
| C002 | error | check | type mismatch | an operand, argument, initializer, condition, return value or list item of the wrong type; a dataset declared with a non-list type |
| C003 | error | check | wrong number of arguments | a call with the wrong arity |
| C004 | error | check | unknown or duplicate named argument | a drawing or `group` argument that does not exist or is given twice |
| C005 | error | check | missing required named argument | a required primitive argument is absent |
| C006 | error | check | assignment to an immutable binding | assigning to a `let`, parameter, loop variable, dataset, function, constant or scene input |
| C007 | error | check | duplicate declaration in the same scope | the same name declared twice in one scope |
| C008 | error | check | not callable | calling a primitive or a local binding as a function; using a non-primitive as a drawing statement |
| C009 | error | check | function may finish without returning a value | a function body that does not definitely return |
| C010 | error | check | return outside a function | `return` in the scene |
| C011 | error | check | drawing inside a function | a primitive or `group` in a function body |
| C012 | error | check | recursion is not allowed | a cycle in the function call graph |
| C013 | error | check | empty list needs a declared element type | `[]` with no expected list type |
| C014 | error | check | unsupported operation for this type | unary operator on the wrong type, indexing a non-list, a function used as a value |
| C015 | error | check | nested lists are not supported | `List<List<T>>` in an annotation, or a list literal whose items are lists |
| C016 | error | check | list literal too long | more than 1,000 items |
| C017 | error | check | reserved name | declaring a built-in, primitive, constant or scene-input name |
| C018 | error | check | no field with this name | a field other than `x y` on a Point or `r g b a` on a Color, or any field on another type |
| C019 | error | check | invalid scene option value | size or frames out of range, or an option repeated |
| C020 | error | check | duplicate function or data name | two `fn`/`data` declarations with one name |
| W001 | warning | check | binding shadows an outer binding | see section 6 |
| W002 | warning | check | unreachable statement | see section 6 |
| W003 | warning | check | unused binding | see section 6 |
| F001 | error | fixture | fixture missing | the host's fixture table has no entry with that name |
| F002 | error | fixture | fixture does not match its declared type | the fixture is not a list or an element has the wrong shape |
| F003 | error | fixture | invalid fixture name | the name does not match `^[a-z][a-z0-9_-]{0,63}$` |
| F004 | error | fixture | fixture too large | more than 10,000 items |
| S001 | error | lex | source too large | more than 64,000 characters, or more than 20,000 tokens |
| S002 | error | limits / parse | program too large (AST nodes) | more than 20,000 AST nodes (stage `limits`); also expression nesting over 200 levels (stage `parse`) |
| S003 | error | check | too many symbols | more than 2,000 declared symbols |

Not in the table: `ICE` (internal compiler error). The pipeline turns any exception thrown inside a compiler
stage, and any IR or bytecode verifier failure, into a diagnostic with code `ICE` instead of crashing the host.
An `ICE` is always a compiler bug (or, today, the deep-statement-nesting case noted in `LIMITATIONS.md`).

## 8. Fixture binding

After checking, `loadFixtures` binds each `data` declaration to an entry of the host's fixture table and
validates it against the declared element type. The rules are in `FOLIO_LANGUAGE_SPEC.md` section 11; failures
are the `F` codes above. A program with fixture errors does not proceed to lowering.

## 9. What the checker records

`CheckResult` (consumed by the lowering, the reference interpreter and the IDE):

| Field | Content |
|---|---|
| `types` | AST node id to type, for every expression |
| `resolutions` | Name, Assign, Call and Let node ids to symbol ids |
| `symbols`, `scopes` | every declared symbol (kind, type, declaration span, uses) and the scope tree |
| `fns`, `data` | function signatures and dataset declarations |
| `callGraph` | function name to the user functions it calls |
| `trace` | one derivation step per typed expression, in checking order |
| `scene` | title, width, height, frames, background after defaults |

Known imprecision: when a local binding has the same name as a function, the checker records the call's
resolution against the local symbol even though the call runs the function. This affects only IDE features that
read `resolutions` (for example hover or go-to-definition), not compilation.
