// Runtime values shared by the reference interpreter and the VM (the representation, not the evaluation).
import type { Span } from './diagnostics.ts';

export interface ColorV { readonly t: 'color'; readonly r: number; readonly g: number; readonly b: number; readonly a: number }
export interface PointV { readonly t: 'point'; readonly x: number; readonly y: number }
/** `null` is internal only: the "no colour" default of optional fill/stroke arguments. FOLIO has no null literal. */
export type Value = number | boolean | string | ColorV | PointV | readonly Value[] | null;

/**
 * A lookup table with no prototype: names from programs (`toString`, `constructor`, `__proto__`) can never find
 * an inherited property through `in` or `[]`.
 */
export function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

export type FaultCode =
  | 'R001' | 'R002' | 'R003' | 'R004' | 'R005' | 'R006' | 'R007' | 'R008' | 'R009' | 'R010' | 'R011' | 'R012' | 'R013' | 'R014';

export const FAULT_CODES: Record<FaultCode, string> = {
  R001: 'arithmetic produced a non-finite number (division by zero, overflow or NaN)',
  R002: 'list index out of range or not a whole number',
  R003: 'assertion failed',
  R004: 'loop iteration limit exceeded',
  R005: 'drawing limit exceeded (shapes per frame, or scene size per frame or per run)',
  R006: 'execution fuel exhausted (VM, per frame or per run)',
  R007: 'call depth or operand stack limit exceeded (VM)',
  R008: 'range bounds must be whole numbers',
  R009: 'string too long',
  R010: 'negative size argument',
  R011: 'groups nested too deeply',
  R012: 'invalid bytecode reached at run time',
  R013: 'user-function call limit exceeded',
  R014: 'evaluation budget exhausted (reference interpreter, per frame or per run)',
};

/** A runtime fault. `span` is the source location of the failing operation. */
export class FolioFault extends Error {
  code: FaultCode;
  span: Span | null;
  constructor(code: FaultCode, message: string, span: Span | null = null) {
    super(message);
    this.code = code;
    this.span = span;
  }
}

/** Thrown by builtins and the scene builder before a span is known; callers attach the span. */
export class FaultSignal extends Error {
  code: FaultCode;
  constructor(code: FaultCode, message: string) { super(message); this.code = code; }
}

export function color(r: number, g: number, b: number, a = 1): ColorV {
  const c8 = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return Object.freeze({ t: 'color', r: c8(r), g: c8(g), b: c8(b), a: Math.round(Math.min(1, Math.max(0, a)) * 255) / 255 });
}
export function colorFromHex(hex: string): ColorV {
  const h = hex.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return color(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1);
}
export function colorHex(c: ColorV): string {
  const x = (v: number) => v.toString(16).padStart(2, '0');
  return '#' + x(c.r) + x(c.g) + x(c.b) + x(Math.round(c.a * 255));
}
export function point(x: number, y: number): PointV { return Object.freeze({ t: 'point', x, y }); }

export function isColor(v: Value): v is ColorV { return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as ColorV).t === 'color'; }
export function isPoint(v: Value): v is PointV { return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as PointV).t === 'point'; }

export function finite(n: number, what: string): number {
  if (!Number.isFinite(n)) throw new FaultSignal('R001', `${what} produced ${Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity'}`);
  return n;
}

/** Structural equality for the types `==` accepts (Number, Boolean, String, Color). */
export function valueEquals(a: Value, b: Value): boolean {
  if (isColor(a) && isColor(b)) return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  return a === b;
}

/** Human-readable rendering for the debugger and the IR view. */
export function showValue(v: Value): string {
  if (v === null) return 'none';
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.slice(0, 8).map(showValue).join(', ') + (v.length > 8 ? `, … ${v.length - 8} more` : '') + ']';
  if (isColor(v as Value)) return colorHex(v as ColorV);
  const p = v as PointV;
  return `point(${p.x}, ${p.y})`;
}

/** JSON-safe encoding used in IR constants and serialized bytecode. */
/** `{ neg0: true }` exists because JSON (and canonical JSON) writes -0 as 0; FOLIO keeps -0 observable
 * (atan2, 1 / x), so constants must round-trip it exactly. */
export type EncodedValue = number | boolean | string | null | { neg0: true } | { color: string } | { point: [number, number] } | { list: EncodedValue[] };
export function encodeValue(v: Value): EncodedValue {
  if (typeof v === 'number' && Object.is(v, -0)) return { neg0: true };
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (Array.isArray(v)) return { list: v.map(encodeValue) };
  if (isColor(v as Value)) return { color: colorHex(v as ColorV) };
  const p = v as PointV;
  return { point: [p.x, p.y] };
}
export function decodeValue(e: EncodedValue): Value {
  if (e === null || typeof e === 'number' || typeof e === 'boolean' || typeof e === 'string') return e;
  if ('neg0' in e) return -0;
  if ('list' in e) return Object.freeze(e.list.map(decodeValue));
  if ('color' in e) return colorFromHex(e.color);
  return point(e.point[0], e.point[1]);
}
