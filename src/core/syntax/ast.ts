// AST for the Witness model language (WML). See docs/MODEL_LANGUAGE.md.
// The AST is plain data: it is never executed directly by the explorer. The explorer
// works on the resolved IR (src/core/model/ir.ts); the independent replay evaluator
// (src/core/replay) interprets this AST with its own name resolution.

export interface Span {
  line: number; // 1-based
  col: number; // 1-based
  offset: number; // 0-based, start
  end: number; // 0-based, exclusive
}

export type Expr =
  | { kind: 'int'; value: number; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'name'; name: string; span: Span } // var, local, param or enum literal
  | { kind: 'qualified'; process: string; name: string; span: Span } // P.x
  | { kind: 'self'; span: Span }
  | { kind: 'unary'; op: 'not' | 'neg'; arg: Expr; span: Span }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr; span: Span }
  | { kind: 'ite'; cond: Expr; then: Expr; else: Expr; span: Span };

export type BinOp =
  | 'and' | 'or' | 'implies'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | '+' | '-' | '*' | '%';

export type TypeExpr =
  | { kind: 'range'; min: Expr; max: Expr; span: Span }
  | { kind: 'bool'; span: Span }
  | { kind: 'named'; name: string; span: Span }
  | { kind: 'enum'; literals: string[]; span: Span };

export type InitSpec =
  | { kind: 'value'; expr: Expr }
  | { kind: 'set'; set: TypeExpr }; // nondeterministic initial value: `in 0..2`, `in {a,b}`, `in bool`

export interface VarDecl {
  name: string;
  type: TypeExpr;
  init: InitSpec;
  span: Span;
}

export interface Assign {
  target: string; // local or global variable name (unqualified) or P.x
  targetProcess?: string;
  value: Expr;
  span: Span;
}

export interface Param {
  name: string;
  domain: TypeExpr;
  span: Span;
}

export interface ActionDecl {
  name: string;
  params: Param[];
  guard: Expr | null;
  body: Assign[];
  span: Span;
}

export interface ProcessDecl {
  names: string[]; // `process A, B { ... }` instantiates the template once per name
  locals: VarDecl[];
  actions: ActionDecl[];
  span: Span;
}

export interface TypeDecl {
  name: string;
  literals: string[];
  span: Span;
}

export interface PropertyDecl {
  name: string;
  kind: 'invariant' | 'eventually' | 'leadsto';
  expr: Expr; // invariant / eventually target / leadsto P
  target?: Expr; // leadsto Q
  span: Span;
}

export interface FairnessDecl {
  strength: 'weak' | 'strong';
  process: string;
  action?: string; // undefined = every action of the process
  span: Span;
}

export interface ConstDecl {
  name: string;
  value: Expr;
  span: Span;
}

export interface ModelAst {
  name: string;
  title: string;
  description: string;
  consts: ConstDecl[];
  types: TypeDecl[];
  vars: VarDecl[];
  processes: ProcessDecl[];
  terminals: Expr[];
  properties: PropertyDecl[];
  fairness: FairnessDecl[];
  span: Span;
}
