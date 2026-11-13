// SQLite persistence (node:sqlite, built into Node 24: no native add-on). Schema changes are numbered
// migrations recorded in schema_migrations; startup applies the missing ones in order inside a transaction.
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'projects, versions, runs',
    sql: `
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, forked_from TEXT);
      CREATE TABLE versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), parent_id TEXT, seq INTEGER NOT NULL,
        source TEXT NOT NULL, source_hash TEXT NOT NULL, fixtures TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL,
        UNIQUE (project_id, seq));
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, project_id TEXT, version_id TEXT, created_at TEXT NOT NULL,
        source_hash TEXT NOT NULL, bytecode_hash TEXT NOT NULL, scene_hash TEXT NOT NULL, trace_hash TEXT NOT NULL,
        agrees INTEGER NOT NULL, fault TEXT, passes TEXT NOT NULL, timing TEXT NOT NULL, receipt TEXT NOT NULL, bytecode TEXT NOT NULL);
      CREATE INDEX runs_created ON runs(created_at DESC);
    `,
  },
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}
