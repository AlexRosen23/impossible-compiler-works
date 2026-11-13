// Resolved intermediate representation of a compiled model.
// Values are encoded as integers: ints are themselves, booleans are 0/1 and enumeration
// literals are indexes into CompiledModel.literals. See docs/TRANSITION_SEMANTICS.md.
import type { ModelAst, Span } from '../syntax/ast.ts';

export type VarType =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'enum'; name: string; literals: string[] };

export type IrExpr =
  | { k: 'const'; v: number; t: 'int' | 'bool' | 'enum' }
  | { k: 'var'; i: number }
  | { k: 'un'; op: 'not' | 'neg'; a: IrExpr }
  | { k: 'bin'; op: 'and' | 'or' | 'implies' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '%'; a: IrExpr; b: IrExpr }
  | { k: 'ite'; c: IrExpr; t: IrExpr; e: IrExpr };

export interface VarInfo {
  index: number;
  name: string; // "counter" or "A.pc"
  process: string | null;
  local: string; // unqualified name
  type: VarType;
  /** Encoded values allowed by the declared domain, ascending in declaration order. */
  domain: number[];
  /** Encoded initial values (one for `= v`, several for `in set`). */
  init: number[];
  span: Span;
}

export interface ActionParam {
  name: string;
  value: number;
  display: string;
}

export interface ActionInfo {
  index: number;
  process: string;
  name: string; // action name inside the process template
  family: string; // "A.read"
  label: string; // "A.read" or "A.send(m=1)"
  params: ActionParam[];
  guard: IrExpr | null;
  guardText: string;
  assigns: { v: number; e: IrExpr; text: string }[];
  span: Span;
}

export interface FairnessInfo {
  strength: 'weak' | 'strong';
  process: string;
  action?: string;
  label: string; // "WF(A)" / "SF(A.acquire)"
  /** Instantiated action indexes covered by this constraint (the disjunction). */
  actions: number[];
  span: Span;
}

export interface InvariantInfo {
  name: string;
  expr: IrExpr;
  text: string;
  span: Span;
}

export interface LivenessInfo {
  name: string;
  kind: 'eventually' | 'leadsto';
  p: IrExpr | null; // leadsto premise
  q: IrExpr;
  text: string;
  span: Span;
}

export interface CompiledModel {
  name: string;
  title: string;
  description: string;
  literals: string[];
  vars: VarInfo[];
  processes: { name: string; actions: number[]; locals: number[] }[];
  actions: ActionInfo[];
  terminal: IrExpr | null;
  terminalText: string;
  invariants: InvariantInfo[];
  liveness: LivenessInfo[];
  fairness: FairnessInfo[];
  /** Product of declared domain sizes (upper bound on |S|). */
  declaredStateSpace: number;
  ast: ModelAst;
}
