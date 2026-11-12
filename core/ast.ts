// FOLIO abstract syntax tree. Every node has a stable numeric id (assigned in source order by the parser) and
// a span. Semantic information (types, symbols) lives in side tables keyed by node id (see checker.ts), so the
// AST itself stays plain data the IDE can render and the formatter can print.
import type { Span } from './diagnostics.ts';

export type PrimTypeName = 'Number' | 'Boolean' | 'String' | 'Color' | 'Point';
export interface TypeNode { kind: 'TypeRef'; id: number; name: PrimTypeName | 'List'; elem: TypeNode | null; span: Span }

export interface Program { kind: 'Program'; id: number; items: Item[]; span: Span }
export type Item = FnDecl | DataDecl | SceneDecl;
export interface Param { kind: 'Param'; id: number; name: string; type: TypeNode; span: Span }
export interface FnDecl { kind: 'FnDecl'; id: number; name: string; nameSpan: Span; params: Param[]; ret: TypeNode; body: Block; span: Span }
export interface DataDecl { kind: 'DataDecl'; id: number; name: string; nameSpan: Span; type: TypeNode; fixture: string; fixtureSpan: Span; span: Span }
export interface SceneOption { name: 'size' | 'frames' | 'background'; values: (number | string)[]; span: Span }
export interface SceneDecl { kind: 'SceneDecl'; id: number; title: string; options: SceneOption[]; body: Block; span: Span }

export interface Block { kind: 'Block'; id: number; stmts: Stmt[]; span: Span }
export type Stmt = LetStmt | AssignStmt | IfStmt | RepeatStmt | ReturnStmt | AssertStmt | DrawStmt | GroupStmt;
export interface LetStmt { kind: 'Let'; id: number; mutable: boolean; name: string; nameSpan: Span; type: TypeNode | null; init: Expr; span: Span }
export interface AssignStmt { kind: 'Assign'; id: number; name: string; nameSpan: Span; value: Expr; span: Span }
export interface IfStmt { kind: 'If'; id: number; cond: Expr; then: Block; else: Block | IfStmt | null; span: Span }
/** `repeat i in a..b { }` (range: from/to set) or `repeat x in list { }` (list: iterable set). */
export interface RepeatStmt { kind: 'Repeat'; id: number; name: string; nameSpan: Span; from: Expr | null; to: Expr | null; iterable: Expr | null; body: Block; span: Span }
export interface ReturnStmt { kind: 'Return'; id: number; value: Expr; span: Span }
export interface AssertStmt { kind: 'Assert'; id: number; cond: Expr; message: string | null; span: Span }
export interface NamedArg { kind: 'NamedArg'; id: number; name: string; nameSpan: Span; value: Expr; span: Span }
export interface DrawStmt { kind: 'Draw'; id: number; prim: string; primSpan: Span; args: NamedArg[]; span: Span }
export interface GroupStmt { kind: 'Group'; id: number; args: NamedArg[]; body: Block; span: Span }

export type Expr = NumLit | StrLit | ColorLit | BoolLit | NameExpr | UnaryExpr | BinaryExpr | CallExpr | IndexExpr | FieldExpr | ListLit;
export interface NumLit { kind: 'Num'; id: number; value: number; span: Span }
export interface StrLit { kind: 'Str'; id: number; value: string; span: Span }
export interface ColorLit { kind: 'Color'; id: number; value: string; span: Span }
export interface BoolLit { kind: 'Bool'; id: number; value: boolean; span: Span }
export interface NameExpr { kind: 'Name'; id: number; name: string; span: Span }
export type UnaryOp = '-' | 'not';
export interface UnaryExpr { kind: 'Unary'; id: number; op: UnaryOp; operand: Expr; span: Span }
export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'and' | 'or';
export interface BinaryExpr { kind: 'Binary'; id: number; op: BinaryOp; left: Expr; right: Expr; span: Span }
export interface CallExpr { kind: 'Call'; id: number; callee: string; calleeSpan: Span; args: Expr[]; span: Span }
export interface IndexExpr { kind: 'Index'; id: number; target: Expr; index: Expr; span: Span }
export interface FieldExpr { kind: 'Field'; id: number; target: Expr; field: string; fieldSpan: Span; span: Span }
export interface ListLit { kind: 'List'; id: number; items: Expr[]; span: Span }

export type AnyNode = Program | Item | Param | Block | Stmt | Expr | NamedArg | TypeNode;

/** Children of a node in source order (used by the AST explorer, node counting and the reducer). */
export function children(n: AnyNode): AnyNode[] {
  switch (n.kind) {
    case 'Program': return n.items;
    case 'FnDecl': return [...n.params, n.ret, n.body];
    case 'Param': return [n.type];
    case 'DataDecl': return [n.type];
    case 'SceneDecl': return [n.body];
    case 'Block': return n.stmts;
    case 'Let': return n.type ? [n.type, n.init] : [n.init];
    case 'Assign': return [n.value];
    case 'If': return n.else ? [n.cond, n.then, n.else] : [n.cond, n.then];
    case 'Repeat': return [n.from, n.to, n.iterable, n.body].filter((x): x is Expr | Block => x !== null);
    case 'Return': return [n.value];
    case 'Assert': return [n.cond];
    case 'Draw': return n.args;
    case 'Group': return [...n.args, n.body];
    case 'NamedArg': return [n.value];
    case 'TypeRef': return n.elem ? [n.elem] : [];
    case 'Unary': return [n.operand];
    case 'Binary': return [n.left, n.right];
    case 'Call': return n.args;
    case 'Index': return [n.target, n.index];
    case 'Field': return [n.target];
    case 'List': return n.items;
    default: return [];
  }
}

export function countNodes(n: AnyNode): number {
  let c = 1;
  for (const k of children(n)) c += countNodes(k);
  return c;
}

export function typeNodeText(t: TypeNode): string {
  return t.name === 'List' ? `List<${t.elem ? typeNodeText(t.elem) : '?'}>` : t.name;
}
