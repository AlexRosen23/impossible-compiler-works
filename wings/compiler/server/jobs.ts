// Runs server/worker.ts jobs one at a time on a worker thread with a wall-clock timeout and a heap cap. A job
// that runs too long is stopped by terminating the worker; one that exhausts its heap kills only the worker. In
// both cases the caller gets a JobError and the next job starts on a fresh worker. A bounded queue answers
// "busy" instead of growing without limit.
import { Worker } from 'node:worker_threads';
import type { Job } from './worker.ts';

export class JobError extends Error {
  reason: 'timeout' | 'crashed' | 'busy' | 'failed';
  constructor(reason: JobError['reason'], message: string) { super(message); this.reason = reason; }
}

export interface JobRunnerOptions { timeoutMs?: number; maxQueue?: number; heapMb?: number }
interface Pending { id: number; job: Job; resolve: (v: unknown) => void; reject: (e: Error) => void }

export class JobRunner {
  readonly timeoutMs: number;
  private maxQueue: number;
  private heapMb: number;
  private worker: Worker | null = null;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private closed = false;

  constructor(o: JobRunnerOptions = {}) {
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxQueue = o.maxQueue ?? 8;
    this.heapMb = o.heapMb ?? 512;
  }

  run<T>(job: Job): Promise<T> {
    if (this.closed) return Promise.reject(new JobError('failed', 'the job runner is closed'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new JobError('busy', 'the compiler is busy; try again in a moment'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new JobError('failed', 'the job runner is closed'));
    if (this.timer) clearTimeout(this.timer);
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: this.heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
    w.unref();
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.current;
      if (!p || p.id !== m.id) return;
      this.finish();
      if (m.ok) p.resolve(m.result); else p.reject(new JobError('failed', m.error ?? 'job failed'));
    });
    w.on('error', (e) => this.lost(w, e.message));
    w.on('exit', (code) => this.lost(w, `worker exited (${code})`));
    return w;
  }

  private lost(w: Worker, why: string) {
    if (this.worker !== w) return;
    this.worker = null;
    const p = this.current;
    this.finish();
    p?.reject(new JobError('crashed', /memory/i.test(why) ? 'the run ran out of memory and was stopped' : `the run was stopped (${why})`));
  }

  private finish() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    queueMicrotask(() => this.pump());
  }

  private pump() {
    if (this.current || this.closed || !this.queue.length) return;
    const p = this.queue.shift()!;
    this.current = p;
    this.worker ??= this.spawn();
    const w = this.worker;
    this.timer = setTimeout(() => {
      if (this.current !== p) return;
      this.worker = null;
      this.finish();
      p.reject(new JobError('timeout', `the run took longer than ${Math.round(this.timeoutMs / 1000)} s and was stopped`));
      void w.terminate();
    }, this.timeoutMs);
    w.postMessage({ id: p.id, job: p.job });
  }
}
