// Semantics of the pure IR/bytecode operations, used by the VM and by constant folding (folding must compute
// exactly what the VM would). The reference interpreter does NOT use this file: it implements the operators
// itself from the language spec, which is what makes it an independent oracle for both.
import { callBuiltin } from './builtins.ts';
import type { Op } from './ir.ts';
import { type ColorV, FaultSignal, type PointV, type Value, finite, isColor, valueEquals } from './values.ts';

export function evalPure(op: Op, a: Value[], meta: { name?: string; field?: string }, maxStr: number): Value {
  const n = (i: number) => a[i] as number;
  switch (op) {
    case 'mov': return a[0];
    case 'add': return finite(n(0) + n(1), '"+"');
    case 'sub': return finite(n(0) - n(1), '"-"');
    case 'mul': return finite(n(0) * n(1), '"*"');
    case 'div': return finite(n(0) / n(1), '"/"');
    case 'mod': return finite(n(0) % n(1), '"%"');
    case 'neg': return -n(0);
    case 'concat': {
      const s = (a[0] as string) + (a[1] as string);
      if (s.length > maxStr) throw new FaultSignal('R009', `string of ${s.length} characters`);
      return s;
    }
    case 'lt': return n(0) < n(1);
    case 'le': return n(0) <= n(1);
    case 'gt': return n(0) > n(1);
    case 'ge': return n(0) >= n(1);
    case 'eq': return valueEquals(a[0], a[1]);
    case 'ne': return !valueEquals(a[0], a[1]);
    case 'not': return !(a[0] as boolean);
    case 'callb': return callBuiltin(meta.name!, a, maxStr);
    case 'list': return Object.freeze([...a]);
    case 'index': {
      const xs = a[0] as Value[];
      const i = n(1);
      if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new FaultSignal('R002', `index ${i} is outside 0..${xs.length - 1}`);
      return xs[i];
    }
    case 'field': {
      const t = a[0];
      if (isColor(t)) return (t as ColorV)[meta.field as 'r' | 'g' | 'b' | 'a'];
      return (t as PointV)[meta.field as 'x' | 'y'];
    }
    case 'len': return (a[0] as Value[]).length;
    default: throw new Error(`evalPure: ${op} is not pure`);
  }
}
