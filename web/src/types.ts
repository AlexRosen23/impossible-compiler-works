export type Value = number | boolean | string;

export interface TraceStep {
  step: number; stateId: number; state: Record<string, Value>; action: string | null; actionIndex: number | null;
  process: string | null; guard: string | null; changes: { variable: string; from: Value; to: Value }[]; stutter?: boolean;
}
export interface Trace {
  kind: 'invariant' | 'deadlock' | 'domain' | 'liveness' | 'eval-error'; property: string; steps: TraceStep[];
  loopStart?: number; stutterForever?: boolean; badWrite?: { variable: string; value: number }; length: number; traceHash: string;
}
export type PropertyStatus = 'VERIFIED_BOUNDED' | 'VIOLATED' | 'INCOMPLETE' | 'UNSUPPORTED' | 'NOT_RUN' | 'ERROR';
export interface PropertyResult {
  name: string; kind: 'invariant' | 'deadlock-freedom' | 'domain' | 'eventually' | 'leadsto'; text: string; status: PropertyStatus;
  violatingStates?: number; trace?: Trace; note: string; checkedBy: 'internal';
}
export interface ActionMeta { label: string; family: string; process: string; guard: string; assigns: string[]; reads: string[]; writes: string[] }
export interface GraphNode { id: number; depth: number; key: string; flags: number; scc: number; viol?: string[] }
export interface GraphEdge { from: number; to: number; action: number }
export interface TlcComparison { property: string; internal: string; tlc: string; agree: boolean; note: string }
export interface CheckResult {
  engine: { name: string; version: string; order: string };
  model: {
    name: string; title: string; description: string; vars: { name: string; type: string; process: string | null }[];
    actions: ActionMeta[]; processes: string[]; fairness: string[]; declaredStateSpace: number;
    liveness: { name: string; kind: string; text: string }[]; invariants: { name: string; text: string }[];
  };
  bounds: Record<string, number>;
  verdict: 'VIOLATION_FOUND' | 'NO_VIOLATION_IN_BOUNDED_MODEL' | 'INCOMPLETE' | 'ERROR';
  complete: boolean; capReason: string | null;
  stats: { states: number; edges: number; generated: number; initialStates: number; maxDepth: number; deadlocks: number; terminals: number; elapsedMs: number; peakHeapMB: number; sccs?: number; nontrivialSccs?: number };
  properties: PropertyResult[];
  evalFailures: { state: number; where: string; message: string }[];
  graph?: { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };
  states?: Record<string, Value>[];
  limitations: string[];
  tlc?: { available: boolean; version?: string; runtime?: string; note: string; comparison?: TlcComparison[]; results?: { property: string; status: string; distinctStates?: number; traceLength?: number }[] };
}
export interface MutationResult {
  kind: 'mutation'; baseline: string; score: string;
  results: { id: string; operator: string; description: string; source: string; outcome: 'KILLED' | 'SURVIVED' | 'INVALID' | 'INCOMPLETE'; killedBy?: string; witnessLength?: number; states?: number }[];
}
export interface RunView {
  id: string; kind: 'check' | 'tlc' | 'mutation'; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error: string | null; attempts: number; created_at: string; started_at: string | null; finished_at: string | null;
  bounds: Record<string, number>; progress: { states?: number; edges?: number; depth?: number; elapsedMs?: number; phase?: string } | null;
  model: { id: number; slug: string; title: string; origin: 'example' | 'user' };
  revision: { id: number; rev: number; source_sha256: string; note: string };
  result: (CheckResult & { kind?: undefined }) | MutationResult | null;
  receipt_digest: string | null;
  annotations: { id: number; property: string; text: string; created_at: string }[];
}
export interface Diagnostic { code: string; severity: 'error' | 'warning'; message: string; span?: { line: number; col: number; offset: number; end: number } }
export interface Scenario { id: string; order: number; level: string; concepts: string[]; title: string; broken: string; fixed: string; extra?: string[]; lesson: string; try: string }
export interface ModelRow { id: number; slug: string; title: string; origin: 'example' | 'user'; revisions: number; latest_rev: number }
export interface Revision { id: number; model_id: number; rev: number; source?: string; source_sha256: string; note: string; created_at: string }

export const F_INITIAL = 1, F_VIOLATION = 2, F_DEADLOCK = 4, F_TERMINAL = 8, F_FRONTIER = 16, F_WITNESS = 32, F_DOMAIN = 64;
export const isCheck = (r: RunView['result']): r is CheckResult => !!r && (r as MutationResult).kind !== 'mutation';
