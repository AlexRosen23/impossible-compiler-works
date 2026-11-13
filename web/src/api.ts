import type { Diagnostic, ModelRow, Revision, RunView, Scenario } from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${r.status}`), { status: r.status, body });
  return body as T;
}
const post = <T>(path: string, body: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  catalog: () => req<{ scenarios: Scenario[]; walkthroughVersion: string }>('/api/catalog'),
  models: () => req<{ models: ModelRow[] }>('/api/models'),
  modelBySlug: (slug: string) => req<{ model: ModelRow; revisions: Revision[]; latest: Revision & { source: string } }>(`/api/models/by-slug/${encodeURIComponent(slug)}`),
  model: (id: number) => req<{ model: ModelRow; revisions: Revision[]; latest: Revision & { source: string } }>(`/api/models/${id}`),
  revision: (id: number) => req<Revision & { source: string }>(`/api/revisions/${id}`),
  diff: (a: number, b: number) => req<{ diff: { op: ' ' | '+' | '-'; text: string; a?: number; b?: number }[] }>(`/api/diff?a=${a}&b=${b}`),
  compile: (source: string) => post<{ ok: boolean; diagnostics: Diagnostic[]; summary: null | { title: string; vars: number; actions: number; processes: string[]; invariants: string[]; liveness: string[]; fairness: string[]; declaredStateSpace: number } }>('/api/compile', { source }),
  createModel: (source: string, note: string) => post<{ model: ModelRow; revision: { id: number; rev: number } }>('/api/models', { source, note }),
  saveRevision: (modelId: number, source: string, note: string) => post<{ revision: { id: number; rev: number } }>(`/api/models/${modelId}/revisions`, { source, note }),
  startRun: (body: { modelId?: number; revisionId?: number; source?: string; note?: string; kind?: 'check' | 'tlc' | 'mutation'; bounds?: Record<string, number> }) => post<{ id: string; status: string; revisionId: number }>('/api/runs', body),
  run: (id: string) => req<RunView>(`/api/runs/${id}`),
  runs: (limit = 100) => req<{ runs: { id: string; kind: string; status: string; verdict: string | null; states: number | null; edges: number | null; complete: number | null; slug: string; title: string; origin: string; rev: number; created_at: string; finished_at: string | null }[] }>(`/api/runs?limit=${limit}`),
  cancel: (id: string) => post<{ cancelled: boolean; status: string }>(`/api/runs/${id}/cancel`, {}),
  receipt: (id: string) => req<Record<string, unknown>>(`/api/runs/${id}/receipt`),
  verify: (receipt: unknown) => post<{ ok: boolean; verdict: 'VALID' | 'REJECTED'; checks: { name: string; ok: boolean; detail: string }[] }>('/api/receipts/verify', { receipt }),
  tla: (id: string) => req<{ moduleName: string; tla: string; cfg: string; configs: { name: string; purpose: string; cfg: string }[] }>(`/api/runs/${id}/tla`),
  tlc: () => req<{ available: boolean; status: string; reason?: string; version?: string; runtime?: string; pin: { release: string; sha256: string; url: string } }>('/api/tlc'),
  annotate: (id: string, property: string, text: string) => post<{ annotations: RunView['annotations'] }>(`/api/runs/${id}/annotations`, { property, text }),
};

export async function waitForRun(id: string, onUpdate: (r: RunView) => void, signal?: { cancelled: boolean }): Promise<RunView> {
  for (;;) {
    const r = await api.run(id);
    onUpdate(r);
    if (['done', 'failed', 'cancelled'].includes(r.status) || signal?.cancelled) return r;
    await new Promise((res) => setTimeout(res, r.status === 'queued' ? 120 : 200));
  }
}
