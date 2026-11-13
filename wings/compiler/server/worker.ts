// The server's compile-and-run worker. Everything that executes a FOLIO program (recording a run, reproducing a
// receipt, rebuilding an export bundle) happens here, off the HTTP thread, under a wall-clock timeout and a
// memory cap set by server/jobs.ts. The core already bounds every program's work; this thread is the second
// line: if a bound were ever wrong, the worker is terminated and the API keeps answering.
import { parentPort } from 'node:worker_threads';
import {
  type FixtureTable, type PassName, type Receipt, compile, interpret, makeReceipt, printModule, reproduce,
} from '../core/index.ts';

export type Job =
  | { kind: 'record'; project: string; source: string; fixtures: FixtureTable; passes: PassName[]; commit: string | null }
  | { kind: 'reproduce'; receipt: Receipt; bytecode: unknown }
  | { kind: 'bundle'; receipt: Receipt }
  | { kind: 'sleep'; ms: number }
  | { kind: 'grow' };

export function runJob(job: Job): unknown {
  switch (job.kind) {
    case 'record': {
      const { receipt, compiled } = makeReceipt({ project: job.project, source: job.source, fixtures: job.fixtures, passes: job.passes, commit: job.commit });
      return { receipt, diagnostics: compiled.diagnostics, bytecode: receipt ? compiled.bytecode : null };
    }
    case 'reproduce':
      return reproduce(job.receipt, job.bytecode);
    case 'bundle': {
      const r = job.receipt;
      const c = compile(r.source, { passes: r.optimizations, fixtures: r.fixtures });
      const ref = c.ok ? interpret(c.program!, c.check!, c.data, c.limits) : null;
      return { ir: c.ok ? printModule(c.irOptimized!) : null, scene: ref?.scene ?? null };
    }
    // Test hooks for the timeout and the memory cap (reachable only through JobRunner, never over HTTP).
    case 'sleep': { const end = Date.now() + job.ms; while (Date.now() < end) { /* busy */ } return 'slept'; }
    case 'grow': { const hog: number[][] = []; for (;;) hog.push(new Array(1e6).fill(1)); }
  }
}

parentPort?.on('message', (msg: { id: number; job: Job }) => {
  try {
    parentPort!.postMessage({ id: msg.id, ok: true, result: runJob(msg.job) });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
});
