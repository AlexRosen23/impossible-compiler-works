# WML — the Witness Model Language

> Part of **THE IMPOSSIBLE COMPILER WORKS**: this document covers the Witness wing (formerly The Impossible Witness). Start at the [root README](../README.md).

A small, typed, declarative language for finite concurrent models. It has no I/O, no
functions, no loops and no strings in expressions: a model can only describe states and
guarded atomic actions, so model input can never run JavaScript, Python or shell code.
Semantics: `TRANSITION_SEMANTICS.md`. Examples: `examples/*.witness`.

## Example

```wml
model counter_race "Two threads share one counter (non-atomic increment)"
description "Each thread reads the counter into a register, then writes register + 1."

var counter : 0..2 = 0

process A, B {                       // one template, two instances
  var pc  : {start, read_done, done} = start
  var tmp : 0..2 = 0
  action read  when pc = start     { tmp := counter; pc := read_done }
  action write when pc = read_done { counter := tmp + 1; pc := done }
}

terminal A.pc = done and B.pc = done
invariant NoLostUpdate: (A.pc = done and B.pc = done) => counter = 2
```

## Grammar (EBNF)

```
model      = "model" IDENT [STRING] { decl } ;
decl       = "title" STRING | "description" STRING
           | "const" IDENT "=" expr
           | "type" IDENT "=" "{" IDENT { "," IDENT } "}"
           | var
           | "process" IDENT { "," IDENT } "{" { var | action } "}"
           | "terminal" [":"] expr
           | "invariant" IDENT ":" expr
           | "liveness" IDENT ":" ( "eventually" expr | expr "leadsto" expr )
           | "fairness" ( "weak" | "strong" ) IDENT [ "." IDENT ] ;
var        = "var" IDENT ":" type ( "=" expr | "in" type ) ;
type       = "bool" | IDENT | "{" IDENT { "," IDENT } "}" | sum ".." sum ;
action     = "action" IDENT [ "(" param { "," param } ")" ] [ "when" expr ] "{" { assign [";"|","] } "}" ;
param      = IDENT "in" type ;
assign     = [ IDENT "." ] IDENT ":=" expr ;
expr       = or [ "=>" expr ] ;                         (* right-associative *)
or         = and { "or" and } ;   and = not { "and" not } ;
not        = "not" not | cmp ;
cmp        = sum [ ( "=" | "!=" | "<" | "<=" | ">" | ">=" ) sum ] ;   (* not chainable *)
sum        = prod { ("+" | "-") prod } ;   prod = unary { ("*" | "%") unary } ;
unary      = "-" unary | primary ;
primary    = INT | "true" | "false" | "self" | IDENT [ "." IDENT ] | "(" expr ")"
           | "if" expr "then" expr "else" expr ;
```

Comments are `// …` and `/* … */`. Keywords are reserved and cannot be names.

## Types and checks (all at compile time, with line:column diagnostics)

- `int` ranges, `bool` and enumerations; enumeration literals are global identifiers and
  may appear in several enumerations. Process names are literals too (for `self`).
- Assignments must fit the target's type; enumeration values are checked against the
  target's literal set (`'B' is not a value of type O`). Comparing two enumerations that can
  never be equal is an error (catches misspelled literals).
- Each variable is assigned at most once per action. Parameters and constants cannot be
  assigned. Locals may not shadow globals.
- Unsupported temporal operators (`always`, `until`, nested `eventually`…) are rejected
  with "Unsupported liveness form" rather than approximated.

## Limits (diagnostic codes)

| limit | value | code |
|---|---|---|
| source size | 64 KiB | E002 |
| tokens | 20,000 | E009 |
| identifier length | 48 | E004 |
| integer literal | 9 digits; ranges within ±10^9 | E005/E221 |
| range width | 1,000,000 values | E220 |
| state variables | 64 | E207 |
| processes | 16 | E202 |
| action instances (after parameter expansion) | 2,000 | E209 |
| initial states | 100,000 | runtime |
| expression nesting | 64 | E100 |

Exploration bounds (states, edges, depth, time, heap) are run options, not language limits;
see `SEARCH_ALGORITHMS.md`.

## Diagnostics

Errors carry a code (`E1xx` syntax, `E2xx` semantic), a message and a source span; warnings
(`W2xx`) do not block running — for example an action that assigns nothing (pure stutter) or
fairness declared without any liveness property.
