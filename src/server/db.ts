// SQLite persistence (node:sqlite). Revisions and finished runs are immutable; a run's
// row moves queued -> running -> done | failed | cancelled exactly once.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const LIMITS = {
  maxModels: 500,
  maxRevisionsPerModel: 300,
  maxRuns: 5_000,
  maxDbBytes: 512 * 1024 * 1024,
  maxAnnotationChars: 2_000,
  maxNoteChars: 300,
};

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type RunKind = 'check' | 'tlc' | 'mutation';

export interface ModelRow { id: number; slug: string; title: string; origin: 'example' | 'user'; created_at: string }
export interface RevisionRow { id: number; model_id: number; rev: number; source: string; source_sha256: string; note: string; created_at: string }
export interface RunRow {
  id: string; revision_id: number; kind: RunKind; status: RunStatus; bounds: string; progress: string | null;
  result: string | null; receipt: string | null; error: string | null; attempts: number;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export class Store {
  db: DatabaseSync;
  file: string;
  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('example','user')), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY, model_id INTEGER NOT NULL REFERENCES models(id), rev INTEGER NOT NULL,
        source TEXT NOT NULL, source_sha256 TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE (model_id, rev));
      CREATE INDEX IF NOT EXISTS revisions_sha ON revisions(model_id, source_sha256);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, revision_id INTEGER NOT NULL REFERENCES revisions(id), kind TEXT NOT NULL,
        status TEXT NOT NULL, bounds TEXT NOT NULL, progress TEXT, result TEXT, receipt TEXT, error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
      CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), property TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }

  now(): string { return new Date().toISOString(); }

  sizeBytes(): number {
    if (this.file === ':memory:') return 0;
    try { return statSync(this.file).size + (statSync(this.file + '-wal', { throwIfNoEntry: false })?.size ?? 0); } catch { return 0; }
  }

  storageOk(): boolean { return this.sizeBytes() < LIMITS.maxDbBytes; }

  models(): (ModelRow & { revisions: number; latest_rev: number })[] {
    return this.db.prepare(`SELECT m.*, COUNT(r.id) AS revisions, MAX(r.rev) AS latest_rev FROM models m LEFT JOIN revisions r ON r.model_id = m.id GROUP BY m.id ORDER BY m.origin, m.slug`).all() as never;
  }
  model(id: number): ModelRow | undefined { return this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as never; }
  modelBySlug(slug: string): ModelRow | undefined { return this.db.prepare('SELECT * FROM models WHERE slug = ?').get(slug) as never; }

  createModel(slug: string, title: string, origin: 'example' | 'user'): ModelRow {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n;
    if (count >= LIMITS.maxModels) throw new HttpError(507, 'model limit reached');
    this.db.prepare('INSERT INTO models (slug, title, origin, created_at) VALUES (?, ?, ?, ?)').run(slug, title, origin, this.now());
    return this.modelBySlug(slug)!;
  }

  revisions(modelId: number): Omit<RevisionRow, 'source'>[] {
    return this.db.prepare('SELECT id, model_id, rev, source_sha256, note, created_at FROM revisions WHERE model_id = ? ORDER BY rev DESC').all(modelId) as never;
  }
  revision(id: number): RevisionRow | undefined { return this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(id) as never; }
  latestRevision(modelId: number): RevisionRow | undefined { return this.db.prepare('SELECT * FROM revisions WHERE model_id = ? ORDER BY rev DESC LIMIT 1').get(modelId) as never; }

  /** Content-addressed: re-saving identical source returns the existing revision. */
  addRevision(modelId: number, source: string, note: string): RevisionRow {
    const sha = createHash('sha256').update(source).digest('hex');
    const latest = this.latestRevision(modelId);
    if (latest && latest.source_sha256 === sha) return latest;
    const existing = this.db.prepare('SELECT * FROM revisions WHERE model_id = ? AND source_sha256 = ? ORDER BY rev DESC LIMIT 1').get(modelId, sha) as RevisionRow | undefined;
    if (existing && !note) return existing;
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE model_id = ?').get(modelId) as { n: number }).n;
    if (n >= LIMITS.maxRevisionsPerModel) throw new HttpError(507, 'revision limit reached for this model');
    if (!this.storageOk()) throw new HttpError(507, 'storage limit reached');
    const rev = (latest?.rev ?? 0) + 1;
    this.db.prepare('INSERT INTO revisions (model_id, rev, source, source_sha256, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(modelId, rev, source, sha, note.slice(0, LIMITS.maxNoteChars), this.now());
    return this.db.prepare('SELECT * FROM revisions WHERE model_id = ? AND rev = ?').get(modelId, rev) as never;
  }

  createRun(revisionId: number, kind: RunKind, bounds: object): RunRow {
    if (!this.storageOk()) throw new HttpError(507, 'storage limit reached; delete data/ or raise the cap');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    if (count >= LIMITS.maxRuns) throw new HttpError(507, 'run limit reached');
    const id = `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    this.db.prepare('INSERT INTO runs (id, revision_id, kind, status, bounds, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, revisionId, kind, 'queued', JSON.stringify(bounds), this.now());
    return this.run(id)!;
  }
  run(id: string): RunRow | undefined { return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as never; }
  runs(limit: number): (Omit<RunRow, 'result' | 'receipt'> & { verdict: string | null; states: number | null; edges: number | null; complete: number | null; slug: string; title: string; origin: string; rev: number })[] {
    return this.db.prepare(`
      SELECT r.id, r.revision_id, r.kind, r.status, r.bounds, r.progress, r.error, r.attempts, r.created_at, r.started_at, r.finished_at,
        json_extract(r.result, '$.verdict') AS verdict, json_extract(r.result, '$.stats.states') AS states,
        json_extract(r.result, '$.stats.edges') AS edges, json_extract(r.result, '$.complete') AS complete,
        m.slug, m.title, m.origin, v.rev
      FROM runs r JOIN revisions v ON v.id = r.revision_id JOIN models m ON m.id = v.model_id
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(limit) as never;
  }
  nextQueued(): RunRow | undefined { return this.db.prepare(`SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`).get() as never; }
  markRunning(id: string): void { this.db.prepare(`UPDATE runs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).run(this.now(), id); }
  setProgress(id: string, p: object): void { this.db.prepare(`UPDATE runs SET progress = ? WHERE id = ? AND status = 'running'`).run(JSON.stringify(p), id); }
  finish(id: string, status: 'done' | 'failed' | 'cancelled', fields: { result?: string; receipt?: string; error?: string }): void {
    this.db.prepare(`UPDATE runs SET status = ?, result = COALESCE(?, result), receipt = COALESCE(?, receipt), error = COALESCE(?, error), finished_at = ? WHERE id = ? AND status IN ('queued','running')`)
      .run(status, fields.result ?? null, fields.receipt ?? null, fields.error ?? null, this.now(), id);
  }
  /** Crash recovery: runs left 'running' by a dead process are re-queued once, then failed. */
  recover(): { requeued: number; failed: number } {
    const stale = this.db.prepare(`SELECT id, attempts FROM runs WHERE status = 'running'`).all() as { id: string; attempts: number }[];
    let requeued = 0, failed = 0;
    for (const r of stale) {
      if (r.attempts < 2) { this.db.prepare(`UPDATE runs SET status = 'queued', progress = NULL, error = 'recovered after a server/worker crash' WHERE id = ?`).run(r.id); requeued++; }
      else { this.db.prepare(`UPDATE runs SET status = 'failed', error = 'worker crashed twice; giving up', finished_at = ? WHERE id = ?`).run(this.now(), r.id); failed++; }
    }
    return { requeued, failed };
  }

  annotations(runId: string): { id: number; property: string; text: string; created_at: string }[] {
    return this.db.prepare('SELECT id, property, text, created_at FROM annotations WHERE run_id = ? ORDER BY id').all(runId) as never;
  }
  annotate(runId: string, property: string, text: string): void {
    this.db.prepare('INSERT INTO annotations (run_id, property, text, created_at) VALUES (?, ?, ?, ?)').run(runId, property.slice(0, 64), text.slice(0, LIMITS.maxAnnotationChars), this.now());
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
