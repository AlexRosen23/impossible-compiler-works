// The output device: a normalized, bounded command buffer. Both executors draw through SceneBuilder, so "the
// same program drew the same thing" is a byte comparison of canonical JSON. Renderers consume only validated
// buffers (validateScene) and draw text with canvas fillText: FOLIO strings never become HTML or CSS.
import type { Limits } from './limits.ts';
import { PRIMITIVES } from './primitives.ts';
import { canonicalJson, sha256 } from './sha256.ts';
import { type ColorV, FaultSignal, type PointV, type Value, colorHex } from './values.ts';
import { SCENE_FORMAT } from './version.ts';

export type Matrix = [number, number, number, number, number, number];
export interface DrawCmd {
  k: 'circle' | 'rect' | 'line' | 'path' | 'text';
  /** Primitive arguments after defaults, numbers quantized to 1e-4, colours as #rrggbbaa or null. */
  a: Record<string, number | string | boolean | null | number[][]>;
  /** Accumulated group transform [a, b, c, d, e, f] and opacity. */
  m: Matrix;
  o: number;
}
export interface Frame { index: number; time: number; cmds: DrawCmd[] }
export interface SceneOutput {
  format: string;
  title: string;
  width: number;
  height: number;
  background: string;
  frames: Frame[];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function q(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function encodeArg(type: string, v: Value): number | string | boolean | null | number[][] {
  if (v === null) return null;
  if (type === 'Number') return q(v as number);
  if (type === 'Color') return colorHex(v as ColorV);
  if (type === 'Point') return [[q((v as PointV).x), q((v as PointV).y)]];
  if (type === 'List<Point>') return (v as PointV[]).map((p) => [q(p.x), q(p.y)]);
  return v as string | boolean;
}

export class SceneBuilder {
  cmds: DrawCmd[] = [];
  private stack: { m: Matrix; o: number }[] = [{ m: IDENTITY, o: 1 }];
  private limits: Limits;
  constructor(limits: Limits) { this.limits = limits; }

  /** args are in the primitive's declared parameter order, defaults already applied. */
  draw(kind: DrawCmd['k'], args: Value[]): void {
    const sig = PRIMITIVES[kind];
    if (this.cmds.length >= this.limits.maxDrawsPerFrame) throw new FaultSignal('R005', `more than ${this.limits.maxDrawsPerFrame} shapes in one frame`);
    const a: DrawCmd['a'] = {};
    sig.params.forEach((p, i) => {
      const v = args[i];
      if (p.nonNegative && typeof v === 'number' && v < 0) throw new FaultSignal('R010', `${kind} ${p.name} is ${v}; it must be 0 or more`);
      if (kind === 'path' && p.name === 'points' && (v as Value[]).length > this.limits.maxFixtureLength) throw new FaultSignal('R005', 'path has too many points');
      a[p.name] = encodeArg(p.type, v);
    });
    const top = this.stack[this.stack.length - 1];
    this.cmds.push({ k: kind, a, m: top.m.map(q) as Matrix, o: q(top.o) });
  }

  pushGroup(translate: PointV, rotateDeg: number, scale: number, opacity: number): void {
    if (this.stack.length > this.limits.maxGroupDepth) throw new FaultSignal('R011', `groups nested more than ${this.limits.maxGroupDepth} deep`);
    const top = this.stack[this.stack.length - 1];
    const r = (rotateDeg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const local: Matrix = [c * scale, s * scale, -s * scale, c * scale, translate.x, translate.y];
    this.stack.push({ m: mul(top.m, local), o: top.o * Math.min(1, Math.max(0, opacity)) });
  }
  popGroup(): void { if (this.stack.length > 1) this.stack.pop(); }
  depth(): number { return this.stack.length - 1; }
}

export function sceneHash(s: SceneOutput): string { return sha256(canonicalJson(s)); }
export function frameHash(f: Frame): string { return sha256(canonicalJson(f)); }

/** Renderer-side validation: shape, bounds and types of a command buffer (never trust a stored scene). */
export function validateScene(s: unknown, limits: Limits): string[] {
  const errs: string[] = [];
  const o = s as SceneOutput;
  if (!o || o.format !== SCENE_FORMAT) return ['unknown scene format'];
  if (!(o.width > 0 && o.width <= limits.maxCanvas && o.height > 0 && o.height <= limits.maxCanvas)) errs.push('canvas size out of range');
  if (typeof o.background !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(o.background)) errs.push('bad background colour');
  if (!Array.isArray(o.frames) || o.frames.length > limits.maxFrames) return [...errs, 'bad frame list'];
  for (const f of o.frames) {
    if (!Array.isArray(f.cmds) || f.cmds.length > limits.maxDrawsPerFrame) { errs.push('bad command list'); continue; }
    for (const c of f.cmds) {
      if (!(c.k in PRIMITIVES)) errs.push(`unknown primitive ${String(c.k)}`);
      if (!Array.isArray(c.m) || c.m.length !== 6 || !c.m.every(Number.isFinite)) errs.push('bad transform');
      if (typeof c.o !== 'number' || !(c.o >= 0 && c.o <= 1)) errs.push('bad opacity');
      for (const [k, v] of Object.entries(c.a ?? {})) {
        if (typeof v === 'number' && !Number.isFinite(v)) errs.push(`non-finite ${k}`);
        if (typeof v === 'string' && k !== 'value' && !/^#[0-9a-f]{8}$/.test(v)) errs.push(`bad colour ${k}`);
        if (typeof v === 'string' && v.length > limits.maxStringLength) errs.push('string too long');
        if (Array.isArray(v) && !v.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((x) => typeof x === 'number' && Number.isFinite(x)))) errs.push(`bad point in ${k}`);
      }
    }
    if (errs.length > 20) break;
  }
  return errs;
}
