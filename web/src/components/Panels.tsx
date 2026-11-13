// Lower-deck rooms: Invariant Hall, Temporal Observatory, States table, Proof Observatory.
import { useEffect, useMemo, useState } from 'react';
import { api, waitForRun } from '../api';
import type { CheckResult, MutationResult, PropertyResult, RunView } from '../types';
import { flagText, show } from './Rail';

export function StatusChip({ s }: { s: string }) {
  return <span className={`status ${s}`}>{s}</span>;
}

// ---- Invariant Hall --------------------------------------------------------------------------
export function InvariantHall({ result, onShowTrace, activeTrace, modelId, source, onOpenMutant }: {
  result: CheckResult; onShowTrace: (p: PropertyResult) => void; activeTrace: string | null; modelId: number | null; source: string; onOpenMutant: (src: string, label: string) => void;
}) {
  const [mut, setMut] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const runMutation = async () => {
    if (!modelId) return;
    setBusy(true);
    try {
      const { id } = await api.startRun({ modelId, source, kind: 'mutation', note: 'mutation testing' });
      await waitForRun(id, setMut);
    } finally { setBusy(false); }
  };
  const mr = mut?.result as MutationResult | null | undefined;
  const safety = result.properties.filter((p) => p.kind === 'invariant' || p.kind === 'deadlock-freedom' || p.kind === 'domain');
  return (
    <div data-testid="invariant-hall">
      <div className="callout"><b>Invariants</b> are safety properties: they must hold in <i>every reachable state</i>, so a counterexample is a finite path to a bad state (shortest, because the search is breadth-first). <b>Liveness</b> (Temporal Observatory) asks whether something good <i>must eventually</i> happen; its counterexamples are infinite (lassos) and depend on fairness.</div>
      <table className="grid">
        <thead><tr><th>property</th><th>status</th><th>definition</th><th>evidence</th><th></th></tr></thead>
        <tbody>
          {safety.map((p) => (
            <tr key={p.name} className={activeTrace === p.name ? 'sel' : ''}>
              <td className="mono">{p.name}</td>
              <td><StatusChip s={p.status} /></td>
              <td><code>{p.text}</code></td>
              <td style={{ color: 'var(--porcelain-dim)' }}>{p.note}</td>
              <td>{p.trace && <button className="btn small" onClick={() => onShowTrace(p)}>Show witness ({p.trace.length})</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">mutation testing — are these properties strong enough?</div>
      <p style={{ color: 'var(--porcelain-dim)', marginTop: 0 }}>Each mutant deliberately breaks the model (removes a guard, drops an assignment, weakens fairness) and is checked for real. A <b>killed</b> mutant was caught by a property; a <b>survivor</b> is a change your properties cannot see.</p>
      <button className="btn" onClick={runMutation} disabled={busy || !modelId} data-testid="run-mutation">{busy ? 'Running mutants…' : 'Run mutation testing'}</button>
      {mut?.status === 'failed' && <p className="callout red">{mut.error}</p>}
      {mr && (
        <>
          <p><b>{mr.score}</b> (baseline verdict {mr.baseline}).</p>
          <table className="grid">
            <thead><tr><th>#</th><th>mutation</th><th>outcome</th><th>caught by</th><th>witness</th><th></th></tr></thead>
            <tbody>{mr.results.map((r) => (
              <tr key={r.id}><td className="mono">{r.id}</td><td>{r.description}</td><td><StatusChip s={r.outcome} /></td><td className="mono">{r.killedBy ?? '—'}</td><td>{r.witnessLength ?? '—'}</td>
                <td><button className="btn small" onClick={() => onOpenMutant(r.source, r.description)}>Open in editor</button></td></tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---- Temporal Observatory --------------------------------------------------------------------
export function TemporalObservatory({ result, onShowTrace, source, setSource }: { result: CheckResult; onShowTrace: (p: PropertyResult) => void; source: string; setSource: (s: string) => void }) {
  const live = result.properties.filter((p) => p.kind === 'eventually' || p.kind === 'leadsto');
  const current = useMemo(() => {
    const m = new Map<string, string>();
    for (const line of source.split('\n')) {
      const x = /^\s*fairness\s+(weak|strong)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
      if (x) m.set(x[2], x[1]);
    }
    return m;
  }, [source]);
  const setFair = (proc: string, v: string) => {
    // Static pattern, compared by name: no regular expression is ever built from model text.
    const lines = source.split('\n').filter((l) => /^\s*fairness\s+(weak|strong)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(l)?.[2] !== proc);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (v !== 'none') lines.push(`fairness ${v} ${proc}`);
    setSource(lines.join('\n') + '\n');
  };
  return (
    <div data-testid="temporal-observatory">
      <div className="split">
        <div>
          <div className="callout gold"><b>Why reachability is not enough.</b> The graph shows what <i>can</i> happen. A liveness property says something <i>must</i> eventually happen, so its counterexample is an infinite behaviour: a path into a loop (a lasso), or a state where the system may simply stop (stutter) forever. A cycle in the graph is a counterexample only if the behaviour going round it is <i>fair</i> under the declared assumptions.</div>
          <p style={{ color: 'var(--porcelain-dim)' }}>Semantics: TLA+-style. <b>WF</b> (weak fairness): an action that stays enabled forever is eventually taken. <b>SF</b> (strong fairness): an action enabled infinitely often is taken infinitely often. Checked by the internal engine on the complete graph (SCCs + Emerson–Lei); TLC re-checks the same properties in the Proof Observatory.</p>
          <div className="stats" style={{ marginBottom: 10 }}>
            <div className="stat"><b>{result.stats.sccs ?? '—'}</b><span>SCCs</span></div>
            <div className="stat"><b>{result.stats.nontrivialSccs ?? '—'}</b><span>cycles (SCC &gt; 1)</span></div>
            <div className="stat"><b>{result.stats.deadlocks}</b><span>deadlocks</span></div>
          </div>
        </div>
        <div>
          <div className="section-title">fairness assumptions (edit the model, then re-run)</div>
          <table className="grid"><tbody>
            {result.model.processes.map((p) => (
              <tr key={p}><td className="mono">{p}</td><td>
                <select aria-label={`Fairness for process ${p}`} value={current.get(p) ?? 'none'} onChange={(e) => setFair(p, e.target.value)} className="field" style={{ background: 'var(--void-2)', border: '1px solid var(--line)', borderRadius: 6, padding: 3 }}>
                  <option value="none">none (may stop forever)</option><option value="weak">weak (WF)</option><option value="strong">strong (SF)</option>
                </select>
              </td></tr>
            ))}
          </tbody></table>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>In the last run: {result.model.fairness.length ? result.model.fairness.join(', ') : 'no fairness'}. Action-level fairness (<code>fairness strong P.act</code>) can be written in the editor.</p>
        </div>
      </div>
      {live.length === 0 ? <p className="callout">This model declares no liveness property. Add one, e.g. <code>liveness Done: eventually A.pc = done</code> or <code>liveness Resp: A.pc = waiting leadsto A.pc = critical</code>.</p> : (
        <table className="grid">
          <thead><tr><th>property</th><th>status</th><th>definition</th><th>evidence</th><th></th></tr></thead>
          <tbody>{live.map((p) => (
            <tr key={p.name}><td className="mono">{p.name}</td><td><StatusChip s={p.status} /></td><td><code>{p.text}</code></td><td style={{ color: 'var(--porcelain-dim)' }}>{p.note}</td>
              <td>{p.trace && <button className="btn small" onClick={() => onShowTrace(p)}>Show lasso ({p.trace.length})</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

// ---- States table (accessible fallback) ------------------------------------------------------
export function StatesTable({ result, selected, onSelect }: { result: CheckResult; selected: number | null; onSelect: (id: number) => void }) {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<'all' | 'bad' | 'witness'>('all');
  const nodes = result.graph?.nodes ?? [];
  const rows = nodes.filter((n) => filter === 'all' || (filter === 'bad' ? (n.flags & (2 | 4 | 64)) !== 0 : (n.flags & 32) !== 0));
  const per = 100;
  const pages = Math.max(1, Math.ceil(rows.length / per));
  useEffect(() => { if (selected !== null) { const i = rows.findIndex((r) => r.id === selected); if (i >= 0) setPage(Math.floor(i / per)); } }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const vars = result.model.vars.map((v) => v.name);
  return (
    <div data-testid="states-table">
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="field">Show<select value={filter} onChange={(e) => { setFilter(e.target.value as never); setPage(0); }}><option value="all">all states</option><option value="bad">violating / deadlocked</option><option value="witness">witness path</option></select></label>
        <span style={{ color: 'var(--muted)' }}>{rows.length} row(s){result.graph?.truncated ? ` (first ${nodes.length} of ${result.stats.states} states)` : ''}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="mono">{page + 1}/{pages}</span>
        <button className="btn small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="grid">
          <caption className="sr-only">Reachable states with their logical step, status and variable values</caption>
          <thead><tr><th>state</th><th>step</th><th>status</th>{vars.map((v) => <th key={v}>{v}</th>)}</tr></thead>
          <tbody>
            {rows.slice(page * per, page * per + per).map((n) => (
              <tr key={n.id} className={`click ${n.id === selected ? 'sel' : ''}`} onClick={() => onSelect(n.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(n.id); }} aria-selected={n.id === selected}>
                <td className="mono">s{n.id}</td><td>{n.depth}</td><td style={{ fontSize: 11.5 }}>{flagText(n.flags, n.viol).join('; ') || '—'}</td>
                {vars.map((v) => <td key={v} className="mono">{show(result.states?.[n.id]?.[v])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Proof Observatory ----------------------------------------------------------------------
export function ProofObservatory({ run, onRunTlc, tlcRun, busy }: { run: RunView | null; onRunTlc: () => void; tlcRun: RunView | null; busy: boolean }) {
  const [tla, setTla] = useState<{ tla: string; cfg: string; moduleName: string } | null>(null);
  const [tlcStatus, setTlcStatus] = useState<Awaited<ReturnType<typeof api.tlc>> | null>(null);
  useEffect(() => { void api.tlc().then(setTlcStatus).catch(() => setTlcStatus(null)); }, []);
  useEffect(() => { if (run && run.status === 'done') void api.tla(run.id).then(setTla).catch(() => setTla(null)); }, [run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmp = (tlcRun?.result as CheckResult | null)?.tlc;
  return (
    <div data-testid="proof-observatory">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`pill ${tlcStatus?.available ? 'ok' : 'warn'}`}>TLC {tlcStatus ? (tlcStatus.available ? `available · ${tlcStatus.pin.release} · ${tlcStatus.runtime}` : 'INTERNAL_ONLY') : '…'}</span>
        {tlcStatus && !tlcStatus.available && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{tlcStatus.reason}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={onRunTlc} disabled={busy || !run || !tlcStatus?.available} data-testid="run-tlc">{busy ? 'TLC running…' : 'Cross-check with TLC'}</button>
      </div>
      <div className="callout">The internal engine and TLC are independent checkers. The model is exported as a TLA+ module (one operator per action instance), TLC runs once per property inside a network-less container with memory, CPU and time caps, and every TLC counterexample is converted back and re-derived by the independent replay evaluator.</div>
      {tlcRun && tlcRun.status !== 'done' && <div style={{ margin: '8px 0' }}><div className="progress"><div /></div><p style={{ color: 'var(--muted)' }}>{tlcRun.status === 'failed' ? tlcRun.error : `TLC job ${tlcRun.status}…`}</p></div>}
      {cmp && (
        <>
          <p><b>{cmp.note}</b>{cmp.runtime ? <> · runtime {cmp.runtime}</> : null}</p>
          {cmp.comparison && (
            <table className="grid" data-testid="tlc-comparison">
              <thead><tr><th>comparison</th><th>internal engine</th><th>TLC</th><th>agree</th><th>explanation</th></tr></thead>
              <tbody>{cmp.comparison.map((c, i) => (
                <tr key={i}><td className="mono">{c.property}</td><td>{/^[A-Z_]+$/.test(c.internal) ? <StatusChip s={c.internal} /> : <span className="mono">{c.internal}</span>}</td><td className="mono">{c.tlc}</td><td>{c.agree ? <span className="status VALID">yes</span> : <span className="status VIOLATED">NO</span>}</td><td style={{ color: 'var(--porcelain-dim)' }}>{c.note}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
      {tla && (
        <div className="split" style={{ marginTop: 10 }}>
          <div><div className="section-title">generated TLA+ module {tla.moduleName}.tla</div><pre className="code" data-testid="tla-source">{tla.tla}</pre></div>
          <div><div className="section-title">TLC configuration (all properties)</div><pre className="code">{tla.cfg}</pre>
            <p style={{ fontSize: 12.5, color: 'var(--porcelain-dim)' }}>Known differences (docs/TLC_COMPATIBILITY.md): TLC stops at the first error per run, so internal state counts are compared only on the error-free full run; TLC does not promise shortest liveness lassos; an intended terminal state is encoded as a <code>Terminating</code> stutter disjunct so TLC's deadlock check matches.</p></div>
        </div>
      )}
    </div>
  );
}
