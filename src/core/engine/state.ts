// Canonical state encoding. A state is a fixed-length vector of encoded values in
// variable-declaration order. Its canonical key is the decimal encoding joined by ','
// (an exact content key: equal keys <=> equal states; no hashing is involved in dedup).
import { createHash } from 'node:crypto';
import type { CompiledModel, VarInfo } from '../model/ir.ts';

export type StateVec = Int32Array;
export type Value = number | boolean | string;

export function stateKey(s: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += (i ? ',' : '') + s[i];
  return out;
}

export function decodeValue(m: CompiledModel, v: VarInfo, x: number): Value {
  if (v.type.kind === 'bool') return x !== 0;
  if (v.type.kind === 'enum') return m.literals[x] ?? `?${x}`;
  return x;
}

export function encodeValue(m: CompiledModel, v: VarInfo, x: Value): number {
  if (v.type.kind === 'bool') {
    if (typeof x !== 'boolean') throw new Error(`${v.name}: expected boolean`);
    return x ? 1 : 0;
  }
  if (v.type.kind === 'enum') {
    if (typeof x !== 'string') throw new Error(`${v.name}: expected literal`);
    const i = m.literals.indexOf(x);
    if (i < 0) throw new Error(`${v.name}: unknown literal ${x}`);
    return i;
  }
  if (typeof x !== 'number' || !Number.isInteger(x)) throw new Error(`${v.name}: expected integer`);
  return x;
}

/** Human/JSON rendering, keys in declaration order. */
export function renderState(m: CompiledModel, s: ArrayLike<number>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const v of m.vars) out[v.name] = decodeValue(m, v, s[v.index]);
  return out;
}

export function renderValue(m: CompiledModel, vi: number, x: number): string {
  const v = decodeValue(m, m.vars[vi], x);
  return String(v);
}

/** SHA-256 over the canonical rendering: `name=value` lines in declaration order. */
export function stateDigest(m: CompiledModel, s: ArrayLike<number>): string {
  const lines = m.vars.map((v) => `${v.name}=${JSON.stringify(decodeValue(m, v, s[v.index]))}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
