// Checker job worker for the static demo: the same job as src/server/worker.ts (minus the TLC cross-check, which
// needs Java), running in a same-origin module Web Worker. The parent terminates it to cancel or on timeout.
import { compileSource } from '../../../src/core/model/compile.ts';
import { check } from '../../../src/core/engine/check.ts';
import { buildReceipt } from '../../../src/core/receipt/receipt.ts';
import { runMutants } from '../../../src/core/model/mutate.ts';

export interface Job { kind: 'check' | 'mutation'; source: string; bounds: Record<string, number>; graphLimit: number }
export type WorkerMsg =
  | { type: 'progress'; progress: unknown }
  | { type: 'done'; result: unknown; receipt?: unknown }
  | { type: 'failed'; error: string };

const post = (m: WorkerMsg) => (self as unknown as { postMessage(m: WorkerMsg): void }).postMessage(m);

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    const c = compileSource(job.source);
    if (!c.ok) {
      post({ type: 'failed', error: `model does not compile: ${c.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.span ? `${d.span.line}:${d.span.col} ` : ''}${d.message}`).join('; ')}` });
      return;
    }
    if (job.kind === 'mutation') {
      const r = runMutants(job.source, { maxStates: Math.min(job.bounds.maxStates ?? 50_000, 100_000) });
      post({ type: 'done', result: { kind: 'mutation', ...r } });
      return;
    }
    const { result } = check(c.model!, {
      bounds: job.bounds, includeGraph: true, graphLimit: job.graphLimit,
      onProgress: (p) => post({ type: 'progress', progress: p }), progressEvery: 4_096,
    });
    post({ type: 'done', result: { ...result, tlc: undefined }, receipt: buildReceipt(job.source, result) });
  } catch (err) {
    post({ type: 'failed', error: String((err as Error)?.message ?? err) });
  }
};
