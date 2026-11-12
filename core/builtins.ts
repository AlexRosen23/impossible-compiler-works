// Vetted pure built-in functions: the only host functionality a FOLIO program can reach. Each is total over
// its declared types except for the faults listed (non-finite results are turned into R001 by the callers'
// common check). No I/O, no clocks, no randomness: `noise` is a fixed hash.
import { type ColorV, FaultSignal, type PointV, type Value, color, finite, point } from './values.ts';

export interface BuiltinSig { params: string[]; ret: string; impl: (args: Value[], maxStr: number) => Value }

const N = 'Number', C = 'Color', P = 'Point';
const num1 = (f: (x: number) => number): BuiltinSig => ({ params: [N], ret: N, impl: (a) => f(a[0] as number) });
const num2 = (f: (x: number, y: number) => number): BuiltinSig => ({ params: [N, N], ret: N, impl: (a) => f(a[0] as number, a[1] as number) });

function hsl(h: number, s: number, l: number): ColorV {
  const hh = ((h % 360) + 360) % 360 / 60;
  const ss = Math.min(1, Math.max(0, s)), ll = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = ll - c / 2;
  return color((r + m) * 255, (g + m) * 255, (b + m) * 255, 1);
}

export const BUILTINS: Record<string, BuiltinSig> = {
  sin: num1(Math.sin), cos: num1(Math.cos), tan: num1(Math.tan), sqrt: num1(Math.sqrt), abs: num1(Math.abs),
  floor: num1(Math.floor), ceil: num1(Math.ceil), round: num1(Math.round), sign: num1(Math.sign),
  exp: num1(Math.exp), log: num1(Math.log),
  min: num2(Math.min), max: num2(Math.max), pow: num2(Math.pow), atan2: num2(Math.atan2),
  noise: num2((a, b) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); }),
  clamp: { params: [N, N, N], ret: N, impl: (a) => Math.min(Math.max(a[0] as number, a[1] as number), a[2] as number) },
  lerp: { params: [N, N, N], ret: N, impl: (a) => (a[0] as number) + ((a[1] as number) - (a[0] as number)) * (a[2] as number) },
  point: { params: [N, N], ret: P, impl: (a) => point(a[0] as number, a[1] as number) },
  dist: { params: [P, P], ret: N, impl: (a) => Math.hypot((a[0] as PointV).x - (a[1] as PointV).x, (a[0] as PointV).y - (a[1] as PointV).y) },
  rgb: { params: [N, N, N], ret: C, impl: (a) => color(a[0] as number, a[1] as number, a[2] as number, 1) },
  rgba: { params: [N, N, N, N], ret: C, impl: (a) => color(a[0] as number, a[1] as number, a[2] as number, a[3] as number) },
  hsl: { params: [N, N, N], ret: C, impl: (a) => hsl(a[0] as number, a[1] as number, a[2] as number) },
  mix: {
    params: [C, C, N], ret: C, impl: (a) => {
      const x = a[0] as ColorV, y = a[1] as ColorV, t = Math.min(1, Math.max(0, a[2] as number));
      return color(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t, x.a + (y.a - x.a) * t);
    },
  },
  alpha: { params: [C, N], ret: C, impl: (a) => { const c = a[0] as ColorV; return color(c.r, c.g, c.b, a[1] as number); } },
  len: { params: ['List<*>'], ret: N, impl: (a) => (a[0] as Value[]).length },
  str: { params: [N], ret: 'String', impl: (a) => String(a[0] as number) },
  fmt: {
    params: [N, N], ret: 'String', impl: (a) => {
      const d = Math.min(6, Math.max(0, Math.round(a[1] as number)));
      return (a[0] as number).toFixed(d);
    },
  },
};

/** Named constants visible everywhere. */
export const CONSTANTS: Record<string, { type: string; value: number }> = {
  PI: { type: N, value: Math.PI },
  TAU: { type: N, value: Math.PI * 2 },
};

/** Call a builtin with the shared result check: any non-finite numeric result is fault R001. */
export function callBuiltin(name: string, args: Value[], maxStr: number): Value {
  const b = BUILTINS[name];
  const r = b.impl(args, maxStr);
  if (typeof r === 'number') finite(r, `${name}(…)`);
  if (typeof r === 'string' && r.length > maxStr) throw new FaultSignal('R009', `${name}(…) produced a string of ${r.length} characters`);
  if (typeof r === 'object' && r !== null && !Array.isArray(r) && (r as PointV).t === 'point') {
    finite((r as PointV).x, 'point x'); finite((r as PointV).y, 'point y');
  }
  return r;
}

export const BUILTIN_DOCS: Record<string, string> = {
  sin: 'sin(x: Number) -> Number — sine of x radians', cos: 'cos(x: Number) -> Number', tan: 'tan(x: Number) -> Number',
  sqrt: 'sqrt(x: Number) -> Number — faults R001 for x < 0', abs: 'abs(x: Number) -> Number', floor: 'floor(x: Number) -> Number',
  ceil: 'ceil(x: Number) -> Number', round: 'round(x: Number) -> Number — halves round up', sign: 'sign(x: Number) -> Number',
  exp: 'exp(x: Number) -> Number', log: 'log(x: Number) -> Number — faults R001 for x <= 0',
  min: 'min(a: Number, b: Number) -> Number', max: 'max(a: Number, b: Number) -> Number', pow: 'pow(a: Number, b: Number) -> Number',
  atan2: 'atan2(y: Number, x: Number) -> Number', noise: 'noise(a: Number, b: Number) -> Number — deterministic hash in [0, 1)',
  clamp: 'clamp(x: Number, lo: Number, hi: Number) -> Number', lerp: 'lerp(a: Number, b: Number, t: Number) -> Number',
  point: 'point(x: Number, y: Number) -> Point', dist: 'dist(a: Point, b: Point) -> Number',
  rgb: 'rgb(r: Number, g: Number, b: Number) -> Color — components clamped to 0–255', rgba: 'rgba(r, g, b: Number, a: Number) -> Color — a in 0–1',
  hsl: 'hsl(h: Number, s: Number, l: Number) -> Color — h in degrees, s and l in 0–1', mix: 'mix(a: Color, b: Color, t: Number) -> Color',
  alpha: 'alpha(c: Color, a: Number) -> Color', len: 'len(xs: List<T>) -> Number', str: 'str(x: Number) -> String',
  fmt: 'fmt(x: Number, digits: Number) -> String — fixed decimals, 0–6',
};
