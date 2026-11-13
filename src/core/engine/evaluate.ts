// Compiles IR expressions to closures over a state vector. Used by the explorer only;
// the independent replay evaluator (src/core/replay) does not use this file.
import type { IrExpr } from '../model/ir.ts';

export class EvalError extends Error {}

export type Fn = (s: ArrayLike<number>) => number;

const MAX = 2_147_483_647;

function checked(v: number): number {
  if (v > MAX || v < -MAX) throw new EvalError(`integer overflow (${v}) — values must stay within ±2^31`);
  return v;
}

export function compileExpr(e: IrExpr): Fn {
  switch (e.k) {
    case 'const': { const v = e.v; return () => v; }
    case 'var': { const i = e.i; return (s) => s[i]; }
    case 'un': {
      const a = compileExpr(e.a);
      return e.op === 'not' ? (s) => (a(s) ? 0 : 1) : (s) => -a(s);
    }
    case 'ite': {
      const c = compileExpr(e.c), t = compileExpr(e.t), f = compileExpr(e.e);
      return (s) => (c(s) ? t(s) : f(s));
    }
    case 'bin': {
      const a = compileExpr(e.a), b = compileExpr(e.b);
      switch (e.op) {
        case 'and': return (s) => (a(s) && b(s) ? 1 : 0); // short-circuit, like TLA+ /\
        case 'or': return (s) => (a(s) || b(s) ? 1 : 0);
        case 'implies': return (s) => (!a(s) || b(s) ? 1 : 0);
        case '=': return (s) => (a(s) === b(s) ? 1 : 0);
        case '!=': return (s) => (a(s) !== b(s) ? 1 : 0);
        case '<': return (s) => (a(s) < b(s) ? 1 : 0);
        case '<=': return (s) => (a(s) <= b(s) ? 1 : 0);
        case '>': return (s) => (a(s) > b(s) ? 1 : 0);
        case '>=': return (s) => (a(s) >= b(s) ? 1 : 0);
        case '+': return (s) => checked(a(s) + b(s));
        case '-': return (s) => checked(a(s) - b(s));
        case '*': return (s) => checked(a(s) * b(s));
        case '%': return (s) => {
          const y = b(s);
          if (y <= 0) throw new EvalError(`modulo by non-positive value ${y}`);
          const x = a(s);
          return ((x % y) + y) % y;
        };
      }
    }
  }
}
