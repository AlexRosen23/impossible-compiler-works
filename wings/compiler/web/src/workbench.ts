// Shared IDE state: the source, the compile result (computed in the browser by the same core the server uses),
// per-frame execution with the reference-interpreter check, routing, and the API client.
import { createContext, useContext } from 'react';
import {
  type CompileResult, type DrawCmd, type FixtureTable, type PassName, type Span, frameHash, interpret, runVM,
} from '../../core/index.ts';

// The corpus ships inside the bundle (no server needed to read, compile, run or debug).
const exampleFiles = import.meta.glob('../../examples/*.folio', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const failureFiles = import.meta.glob('../../examples/failures/*.folio', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const fixtureFiles = import.meta.glob('../../examples/fixtures/*.json', { import: 'default', eager: true }) as Record<string, unknown>;

export interface CorpusItem { id: string; title: string; blurb: string; source: string; expect?: { kind: 'compile' | 'fault'; code: string; line: number; col: number } | null }
const base = (p: string) => p.split('/').pop()!.replace(/\.(folio|json)$/, '');
const title = (s: string) => /scene\s+"([^"]*)"/.exec(s)?.[1] ?? '';
const blurb = (s: string) => /^\/\/ (.*)$/m.exec(s)?.[1] ?? '';
export const EXAMPLES: CorpusItem[] = Object.entries(exampleFiles).filter(([p]) => /\/\d\d-/.test(p)).sort().map(([p, s]) => ({ id: base(p), title: title(s), blurb: blurb(s), source: s }));
export const FAULT_LAB: CorpusItem = (() => { const [p, s] = Object.entries(exampleFiles).find(([q]) => q.includes('fault-lab'))!; return { id: base(p), title: title(s), blurb: blurb(s), source: s }; })();
export const FAILURES: CorpusItem[] = Object.entries(failureFiles).sort().map(([p, s]) => {
  const m = /^\/\/ expect(-fault)?: ([A-Z]\d{3}) @ (\d+):(\d+)/.exec(s);
  return { id: base(p), title: title(s), blurb: '', source: s, expect: m ? { kind: m[1] ? 'fault' : 'compile', code: m[2], line: Number(m[3]), col: Number(m[4]) } : null };
});
export const FIXTURES: FixtureTable = Object.fromEntries(Object.entries(fixtureFiles).map(([p, v]) => [base(p), v]));

export type Mode = 'editorial' | 'furnace' | 'observatory' | 'lowering' | 'duel' | 'theater' | 'gallery' | 'cabinet';
export const MODES: { id: Mode; label: string; key: string }[] = [
  { id: 'editorial', label: 'Editorial', key: 'A' }, { id: 'furnace', label: 'Syntax Furnace', key: 'B' }, { id: 'observatory', label: 'Type Observatory', key: 'C' },
  { id: 'lowering', label: 'Lowering Floor', key: 'D' }, { id: 'duel', label: 'Optimization Duel', key: 'E' }, { id: 'theater', label: 'Bytecode Theater', key: 'F' },
  { id: 'gallery', label: 'Failure Gallery', key: 'G' }, { id: 'cabinet', label: 'Proof Cabinet', key: 'H' },
];

export interface Route { mode: Mode; example?: string; project?: string }
export const PROJECT_ID = /^[0-9a-f-]{1,36}$/;
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const mode = (MODES.find((m) => m.id === parts[0])?.id ?? 'editorial') as Mode;
  const r: Route = { mode };
  if (parts[1] === 'example' && parts[2]) { try { r.example = decodeURIComponent(parts[2]); } catch { /* malformed escape: ignore */ } }
  // A project id is a server-issued id and nothing else: the value is used in an API path, so anything that
  // is not one (for example ..%2F..%2Fapi%2Fcorpus) is ignored rather than fetched.
  if (parts[1] === 'project' && parts[2] && PROJECT_ID.test(parts[2])) r.project = parts[2];
  return r;
}
export function routeHash(r: Route): string {
  return `#/${r.mode}${r.project ? `/project/${encodeURIComponent(r.project)}` : r.example ? `/example/${encodeURIComponent(r.example)}` : ''}`;
}

export interface FrameRun { cmds: DrawCmd[]; fault: { code: string; message: string; span: Span | null } | null; steps: number; vmHash: string; refHash: string; refFault: string | null; agree: boolean; resourceLimit: boolean; resourceWho: 'VM' | 'reference interpreter' | null; ms: number }
const frameCache = new Map<string, FrameRun>();
/** Run one frame on the VM and on the reference interpreter; cache by bytecode hash + fixtures + frame. */
export function runFrame(c: CompileResult, frame: number): FrameRun | null {
  if (!c.ok || !c.bytecode) return null;
  const key = `${c.bytecode.hash}|${c.sourceHash}|${frame}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const t0 = performance.now();
  const vm = runVM(c.bytecode, c.data, c.limits, frame);
  const ms = performance.now() - t0;
  const ref = interpret(c.program!, c.check!, c.data, c.limits, frame);
  const vf = vm.scene.frames[0], rf = ref.scene.frames[0];
  const fault = vm.fault ? { code: vm.fault.code, message: vm.fault.message, span: vm.fault.span } : null;
  const refFault = ref.fault ? `${ref.fault.code}@${ref.fault.span?.start}` : null;
  const r: FrameRun = {
    cmds: vf?.cmds ?? [], fault, steps: vm.steps[0] ?? 0, vmHash: vf ? frameHash(vf) : '', refHash: rf ? frameHash(rf) : '', refFault,
    agree: !!vf && !!rf && frameHash(vf) === frameHash(rf) && refFault === (vm.fault ? `${vm.fault.code}@${vm.fault.span?.start}` : null), ms,
    resourceLimit: vm.fault?.code === 'R006' || vm.fault?.code === 'R007' || ref.fault?.code === 'R014',
    resourceWho: vm.fault?.code === 'R006' || vm.fault?.code === 'R007' ? 'VM' : ref.fault?.code === 'R014' ? 'reference interpreter' : null,
  };
  if (frameCache.size > 600) frameCache.clear();
  frameCache.set(key, r);
  return r;
}

export interface Workbench {
  source: string;
  setSource(s: string): void;
  passes: PassName[];
  setPasses(p: PassName[]): void;
  compiled: CompileResult;
  frame: number;
  setFrame(f: number): void;
  select(span: Span): void;
  breakpoints: Set<number>;
  setDebugLine(l: number | null): void;
  setMode(m: Mode): void;
  load(source: string, label: string): void;
  toast(msg: string): void;
  label: string;
  online: boolean;
}
export const WB = createContext<Workbench | null>(null);
export function useWB(): Workbench { const w = useContext(WB); if (!w) throw new Error('no workbench'); return w; }

// --- API client (loopback server; the IDE degrades to offline mode without it) --------------------
// In THE IMPOSSIBLE COMPILER WORKS this wing's API is mounted under /engine/compiler on the shared server.
export const API_BASE = '/engine/compiler';
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; data: T }> {
  const res = await fetch(API_BASE + path, { method: init?.method ?? 'GET', headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined, body: init?.body !== undefined ? JSON.stringify(init.body) : undefined });
  const data = (await res.json().catch(() => null)) as T;
  return { status: res.status, data };
}

export function download(name: string, data: unknown) {
  const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Line diff (LCS) for version history. */
export function lineDiff(a: string, b: string): { t: ' ' | '+' | '-'; s: string }[] {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  if (n * m > 4_000_000) return [...x.map((s) => ({ t: '-' as const, s })), ...y.map((s) => ({ t: '+' as const, s }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: x[i++] });
    else out.push({ t: '+', s: y[j++] });
  }
  while (i < n) out.push({ t: '-', s: x[i++] });
  while (j < m) out.push({ t: '+', s: y[j++] });
  return out;
}
