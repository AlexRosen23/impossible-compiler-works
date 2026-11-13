// Checker job worker (worker_threads). One job per worker; the parent terminates the worker
// to cancel a job or when its wall-clock budget is exceeded.
import { parentPort, workerData } from 'node:worker_threads';
import { compileSource } from '../core/model/compile.ts';
import { check } from '../core/engine/check.ts';
import { buildReceipt } from '../core/receipt/receipt.ts';
import { runTlcCrossCheck } from '../core/tla/tlc.ts';
import { runMutants } from '../core/model/mutate.ts';

interface Job { kind: 'check' | 'tlc' | 'mutation'; source: string; bounds: Record<string, number>; graphLimit: number }

async function main(): Promise<void> {
  const job = workerData as Job;
  if (process.env.WITNESS_TEST_CRASH_WORKER === '1') process.exit(3); // test hook: simulate a crash
  const c = compileSource(job.source);
  if (!c.ok) {
    parentPort!.postMessage({ type: 'failed', error: `model does not compile: ${c.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.span ? `${d.span.line}:${d.span.col} ` : ''}${d.message}`).join('; ')}` });
    return;
  }
  if (job.kind === 'mutation') {
    const r = runMutants(job.source, { maxStates: Math.min(job.bounds.maxStates ?? 50_000, 100_000) });
    parentPort!.postMessage({ type: 'done', result: { kind: 'mutation', ...r } });
    return;
  }
  const { result } = check(c.model!, {
    bounds: job.bounds,
    includeGraph: true,
    graphLimit: job.graphLimit,
    onProgress: (p) => parentPort!.postMessage({ type: 'progress', progress: p }),
    progressEvery: 4_096,
  });
  let tlc;
  if (job.kind === 'tlc') {
    parentPort!.postMessage({ type: 'progress', progress: { phase: 'tlc', states: result.stats.states, edges: result.stats.edges, depth: result.stats.maxDepth, elapsedMs: result.stats.elapsedMs } });
    tlc = await runTlcCrossCheck(job.source, c.model!, result);
  }
  const receipt = buildReceipt(job.source, result, { tlc });
  parentPort!.postMessage({ type: 'done', result: { ...result, tlc }, receipt });
}

main().catch((e) => parentPort!.postMessage({ type: 'failed', error: String((e as Error)?.message ?? e) }));
