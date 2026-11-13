import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, waitForRun } from '../api';
import type { CheckResult, Diagnostic, PropertyResult, Revision, RunView, Trace } from '../types';
import { isCheck } from '../types';
import { Editor } from './Editor';
import { Graph, type LayoutMode } from './Graph';
import { Rail } from './Rail';
import { Theater } from './Theater';
import { InvariantHall, ProofObservatory, StatesTable, StatusChip, TemporalObservatory } from './Panels';
import { Archive, Compare } from './Archive';

type Tab = 'theater' | 'invariants' | 'temporal' | 'states' | 'archive' | 'proof' | 'revisions';
const TABS: [Tab, string][] = [['theater', 'Interleaving Theater'], ['invariants', 'Invariant Hall'], ['temporal', 'Temporal Observatory'], ['states', 'States (table)'], ['archive', 'Witness Archive'], ['proof', 'Proof Observatory'], ['revisions', 'Revisions']];

const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Workspace({ initialSlug, runId, journey }: { initialSlug: string; runId?: string; journey?: boolean }) {
  const [slug, setSlug] = useState(initialSlug);
  const [model, setModel] = useState<{ id: number; title: string; origin: string } | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [source, setSource] = useState('');
  const [saved, setSaved] = useState('');
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [note, setNote] = useState('');
  const [bounds, setBounds] = useState({ maxStates: 200000, maxDepth: 5000, timeLimitMs: 30000 });
  const [run, setRun] = useState<RunView | null>(null);
  const [tlcRun, setTlcRun] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [tlcBusy, setTlcBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [traceName, setTraceName] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<LayoutMode>('layers');
  const [tab, setTab] = useState<Tab>('theater');
  const [error, setError] = useState('');
  const [diff, setDiff] = useState<{ op: string; text: string }[] | null>(null);
  const [reduced, setReduced] = useState(prefersReduced());
  const [announce, setAnnounce] = useState('');
  const journeyRuns = useRef<{ broken?: string; fixed?: string }>({});

  const result: CheckResult | null = run && isCheck(run.result) ? run.result : null;
  const trace: Trace | null = useMemo(() => result?.properties.find((p) => p.name === traceName)?.trace ?? null, [result, traceName]);

  const loadModel = useCallback(async (s: string, keepRun = false) => {
    setError('');
    const m = await api.modelBySlug(s);
    setSlug(s);
    setModel({ id: m.model.id, title: m.model.title, origin: m.model.origin });
    setRevisions(m.revisions);
    setSource(m.latest.source);
    setSaved(m.latest.source);
    setDiff(null);
    if (!keepRun) { setRun(null); setTlcRun(null); setSelected(null); setTraceName(null); }
    return m;
  }, []);

  useEffect(() => { void loadModel(initialSlug).catch((e) => setError(String(e.message))); }, [initialSlug, loadModel]);

  const adoptResult = useCallback((r: RunView) => {
    setRun(r);
    if (r.status === 'done' && isCheck(r.result)) {
      const v = r.result.properties.find((p) => p.status === 'VIOLATED' && p.trace);
      setTraceName(v?.name ?? null);
      const last = v?.trace?.steps.filter((s) => s.stateId >= 0).at(-1);
      setSelected(last?.stateId ?? 0);
      setCursor(v?.trace ? v.trace.steps.length - 1 : 0);
      setMode('layers');
      setAnnounce(`${r.result.verdict.replace(/_/g, ' ')}: ${r.result.stats.states} states explored.${v ? ` ${v.name} violated; witness of ${v.trace!.length} steps.` : ''}`);
    }
  }, []);

  useEffect(() => {
    if (!runId) return;
    void (async () => {
      const r = await api.run(runId);
      const rev = await api.revision(r.revision.id);
      await loadModel(r.model.slug, true);
      setSource(rev.source);
      adoptResult(r);
    })().catch((e) => setError(String(e.message)));
  }, [runId, loadModel, adoptResult]);

  const doRun = async (kind: 'check' | 'tlc' = 'check', overrideSlug?: string): Promise<RunView | null> => {
    if (!model && !overrideSlug) return null;
    setError('');
    const setB = kind === 'tlc' ? setTlcBusy : setBusy;
    setB(true);
    try {
      let modelId = model?.id ?? 0;
      let src = source;
      if (overrideSlug) { const m = await loadModel(overrideSlug); modelId = m.model.id; src = m.latest.source; }
      const { id } = await api.startRun({ modelId, source: src, note, bounds, kind });
      setNote('');
      const final = await waitForRun(id, kind === 'tlc' ? setTlcRun : (r) => setRun(r));
      if (kind === 'check') adoptResult(final);
      const m = await api.modelBySlug(overrideSlug ?? slug);
      setRevisions(m.revisions);
      setSaved(src);
      if (final.status === 'failed') setError(final.error ?? 'run failed');
      return final;
    } catch (e) {
      const err = e as Error & { body?: { diagnostics?: Diagnostic[] } };
      setError(err.body?.diagnostics?.length ? `The model does not compile: ${err.body.diagnostics[0].message}` : err.message);
      return null;
    } finally { setB(false); }
  };

  const cancel = async () => { if (run && ['queued', 'running'].includes(run.status)) await api.cancel(run.id); };
  const showTrace = (p: PropertyResult) => {
    setTraceName(p.name);
    const steps = p.trace!.steps;
    setCursor(steps.length - 1);
    const last = steps.filter((s) => s.stateId >= 0).at(-1);
    if (last) setSelected(last.stateId);
    setTab('theater');
  };
  const onSelect = (id: number) => {
    setSelected(id);
    if (trace) { const i = trace.steps.findIndex((s) => s.stateId === id); if (i >= 0) setCursor(i); }
    const st = result?.states?.[id];
    if (st) setAnnounce(`State s${id}, logical step ${result!.graph!.nodes[id].depth}: ${Object.entries(st).map(([k, v]) => `${k} = ${v}`).join(', ')}`);
  };

  const verdict = result?.verdict;
  const vClass = verdict === 'VIOLATION_FOUND' || verdict === 'ERROR' ? 'bad' : verdict === 'INCOMPLETE' ? 'warn' : 'ok';
  const errors = diags.filter((d) => d.severity === 'error');
  const dirty = source !== saved;

  return (
    <>
      <div className="workspace">
        {/* ---- Specification Desk ---- */}
        <section className="panel desk" aria-labelledby="desk-h">
          <header>
            <h2 id="desk-h">Specification Desk</h2>
            <span className="sub" title={model?.title}>{slug}{dirty ? ' · edited' : ''}</span>
          </header>
          <Editor value={source} onChange={setSource} onDiagnostics={setDiags} label={`Model source for ${slug}`} />
          <div className="body" style={{ flex: '0 0 auto', maxHeight: 280 }}>
            <div aria-live="polite" data-testid="diagnostics">
              {diags.length === 0 ? <div className="diag" style={{ color: 'var(--mint)' }}>✓ model compiles</div> : diags.slice(0, 6).map((d, i) => (
                <div key={i} className={`diag ${d.severity}`}>{d.severity === 'error' ? '✗' : '!'} {d.span ? `${d.span.line}:${d.span.col} ` : ''}{d.code} {d.message}</div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="field" style={{ width: 96 }}>Max states<input type="number" min={1} value={bounds.maxStates} onChange={(e) => setBounds({ ...bounds, maxStates: Number(e.target.value) })} data-testid="max-states" /></label>
              <label className="field" style={{ width: 80 }}>Max depth<input type="number" min={1} value={bounds.maxDepth} onChange={(e) => setBounds({ ...bounds, maxDepth: Number(e.target.value) })} /></label>
              <label className="field" style={{ width: 92 }}>Time (ms)<input type="number" min={100} value={bounds.timeLimitMs} onChange={(e) => setBounds({ ...bounds, timeLimitMs: Number(e.target.value) })} /></label>
            </div>
            <label className="field" style={{ marginTop: 6 }}>Revision note (optional)<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. make reserve atomic" /></label>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => void doRun('check')} disabled={busy || errors.length > 0 || !model} data-testid="run-check">{busy ? 'Exploring…' : 'Run model checker'}</button>
              {busy && <button className="btn danger small" onClick={() => void cancel()} data-testid="cancel-run">Cancel</button>}
            </div>
            {busy && run?.progress && <p className="mono" style={{ color: 'var(--muted)', margin: '6px 0 0' }}>{run.status} · {run.progress.states ?? 0} states · depth {run.progress.depth ?? 0}</p>}
            {busy && <div className="progress" style={{ marginTop: 6 }}><div /></div>}
          </div>
        </section>

        {/* ---- Possibility Chamber ---- */}
        <section className="panel chamber" aria-labelledby="chamber-h">
          <header>
            <h2 id="chamber-h">Possibility Chamber</h2>
            {result && <span className={`verdict ${vClass}`} data-testid="verdict">{result.verdict.replace(/_/g, ' ')}</span>}
            <span style={{ flex: 1 }} />
            <div className="row" role="group" aria-label="Graph layout">
              {(['layers', 'witness', 'scc'] as LayoutMode[]).map((m) => (
                <button key={m} className={`btn small ${mode === m ? '' : 'ghost'}`} aria-pressed={mode === m} onClick={() => setMode(m)} disabled={m === 'witness' && !trace}>{m === 'layers' ? 'Breadth-first layers' : m === 'witness' ? 'Shortest witness' : 'Condensed SCCs'}</button>
              ))}
              <button className="btn small ghost" aria-pressed={reduced} onClick={() => setReduced(!reduced)} title="Reduce motion">{reduced ? 'Motion off' : 'Motion on'}</button>
            </div>
          </header>
          {error && <p className="callout red" role="alert" style={{ margin: 10 }}>{error}</p>}
          {result ? (
            <>
              <div className="row" style={{ padding: '6px 12px', gap: 14, borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
                <span className="mono">{result.stats.states.toLocaleString()} states</span>
                <span className="mono">{result.stats.edges.toLocaleString()} transitions</span>
                <span className="mono">{result.stats.maxDepth} logical steps deep</span>
                <span className="mono">{result.stats.elapsedMs} ms</span>
                <span className={`pill ${result.complete ? 'ok' : 'warn'}`}>{result.complete ? 'exhaustive (no cap hit)' : `INCOMPLETE — ${result.capReason} cap`}</span>
                {trace && <span className="pill warn">witness: {trace.property} · {trace.length} steps{trace.loopStart !== undefined ? ' · lasso' : ''}</span>}
              </div>
              <Graph result={result} trace={trace} selected={selected} onSelect={onSelect} mode={mode} reducedMotion={reduced} revealKey={run!.id} />
            </>
          ) : (
            <div className="empty">{busy ? 'Exploring every reachable state…' : 'Run the model checker to see every reachable state of this bounded model.'}</div>
          )}
          <div className="sr-only" aria-live="polite">{announce}</div>
        </section>

        {/* ---- Precision rail ---- */}
        <aside className="panel" aria-labelledby="rail-h">
          <header><h2 id="rail-h">Precision Rail</h2></header>
          <div className="body">
            {result && (
              <>
                <div className="section-title" style={{ marginTop: 0 }}>properties</div>
                <ul className="list" style={{ marginBottom: 8 }} data-testid="property-list">
                  {result.properties.map((p) => (
                    <li key={p.name}><button onClick={() => (p.trace ? showTrace(p) : setTab(p.kind === 'eventually' || p.kind === 'leadsto' ? 'temporal' : 'invariants'))}>
                      <span className="row" style={{ justifyContent: 'space-between' }}><span className="mono">{p.name}</span><span className="sr-only">: </span><StatusChip s={p.status} /></span>
                    </button></li>
                  ))}
                </ul>
                <Rail result={result} selected={selected} onSelect={onSelect} />
              </>
            )}
            {!result && <p style={{ color: 'var(--muted)' }}>Logical step, typed variables, enabled actions and property statuses appear here.</p>}
          </div>
        </aside>

        {/* ---- lower deck ---- */}
        <section className="panel deck" aria-label="Analysis rooms">
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={`tab-${id}`} id={`tabbtn-${id}`} onClick={() => setTab(id)}>{label}</button>)}
          </div>
          <div className="body" role="tabpanel" id={`tab-${tab}`} aria-labelledby={`tabbtn-${tab}`}>
            {tab === 'revisions' ? (
              <div>
                <p style={{ color: 'var(--porcelain-dim)', marginTop: 0 }}>Every run stores the exact source as an immutable, content-addressed revision. Shipped examples are never modified on disk; edits become new local revisions.</p>
                <table className="grid"><thead><tr><th>rev</th><th>sha256</th><th>note</th><th>saved</th><th></th></tr></thead>
                  <tbody>{revisions.map((r) => (
                    <tr key={r.id}><td>r{r.rev}</td><td className="mono">{r.source_sha256.slice(0, 12)}…</td><td>{r.note}</td><td className="mono">{r.created_at.slice(0, 19).replace('T', ' ')}</td>
                      <td className="row"><button className="btn small" onClick={() => void api.revision(r.id).then((x) => setSource(x.source))}>Load</button>
                        <button className="btn small" onClick={() => void api.diff(r.id, revisions[0].id).then((d) => setDiff(d.diff))} disabled={r.id === revisions[0]?.id}>Diff vs latest</button></td></tr>
                  ))}</tbody></table>
                {diff && <pre className="code" style={{ marginTop: 10 }}>{diff.map((l, i) => <div key={i} className={`diffline ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}`}>{l.op} {l.text}</div>)}</pre>}
              </div>
            ) : tab === 'archive' ? <Archive run={run} onOpenRun={(id) => { location.hash = `#/model/${slug}?run=${id}`; }} />
              : tab === 'proof' ? <ProofObservatory run={run} tlcRun={tlcRun} busy={tlcBusy} onRunTlc={() => void doRun('tlc')} />
              : !result ? <div className="empty">No result yet.</div>
              : tab === 'theater' ? <Theater result={result} trace={trace} cursor={cursor} setCursor={setCursor} onSelectState={(id) => setSelected(id)} selected={selected} />
              : tab === 'invariants' ? <InvariantHall result={result} onShowTrace={showTrace} activeTrace={traceName} modelId={model?.id ?? null} source={source} onOpenMutant={(s) => { setSource(s); setNote('mutant'); }} />
              : tab === 'temporal' ? <TemporalObservatory result={result} onShowTrace={(p) => { showTrace(p); setMode('layers'); }} source={source} setSource={setSource} />
              : <StatesTable result={result} selected={selected} onSelect={onSelect} />}
          </div>
        </section>
      </div>
      {journey && <Journey
        run={run} tlcRun={tlcRun} slug={slug}
        doRunBroken={async () => { const r = await doRun('check', 'inventory-race'); journeyRuns.current.broken = r?.id; return r; }}
        doRunFixed={async () => { const r = await doRun('check', 'inventory-atomic'); journeyRuns.current.fixed = r?.id; return r; }}
        doTlc={async () => doRun('tlc')}
        step={(i) => { if (trace && trace.steps[i]) { setCursor(i); const id = trace.steps[i].stateId; if (id >= 0) setSelected(id); } }}
        setTab={setTab} reduced={reduced} trace={trace} runIds={journeyRuns}
      />}
    </>
  );
}

// ---- 90-second recruiter journey ---------------------------------------------------------------
function Journey(props: {
  run: RunView | null; tlcRun: RunView | null; slug: string; trace: Trace | null; reduced: boolean;
  doRunBroken: () => Promise<RunView | null>; doRunFixed: () => Promise<RunView | null>; doTlc: () => Promise<RunView | null>;
  step: (i: number) => void; setTab: (t: Tab) => void; runIds: React.MutableRefObject<{ broken?: string; fixed?: string }>;
}) {
  const [i, setI] = useState(0);
  const [t0] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [cmp, setCmp] = useState<[RunView, RunView] | null>(null);
  const [verify, setVerify] = useState<{ good?: string; tampered?: string }>({});
  const [open, setOpen] = useState(true);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(h); }, []);
  const steps = [
    'The problem: two checkouts, one unit of stock',
    'The counterexample: step the exact schedule',
    'The fix: atomic check-and-reserve, re-checked exhaustively',
    'Compare broken vs repaired reachable states',
    'Independent cross-check with TLC',
    'Receipt: verify it, then tamper with it',
  ];
  const act = async () => {
    setBusy(true);
    try {
      if (i === 0) { await props.doRunBroken(); setI(1); }
      else if (i === 1) {
        props.setTab('theater');
        const n = props.trace?.steps.length ?? 0;
        for (let k = 0; k < n; k++) { props.step(k); await new Promise((r) => setTimeout(r, props.reduced ? 0 : 650)); }
        setI(2);
      } else if (i === 2) { await props.doRunFixed(); setI(3); }
      else if (i === 3) {
        const a = await api.run(props.runIds.current.broken!), b = await api.run(props.runIds.current.fixed!);
        setCmp([a, b]); setI(4);
      } else if (i === 4) { props.setTab('proof'); await props.doTlc(); setI(5); }
      else if (i === 5) {
        props.setTab('archive');
        const rec = await api.receipt(props.runIds.current.fixed!) as Record<string, any>;
        const good = await api.verify(rec);
        rec.result.verdict = 'VIOLATION_FOUND';
        const bad = await api.verify(rec);
        setVerify({ good: good.verdict, tampered: bad.verdict });
        setI(6);
      }
    } finally { setBusy(false); }
  };
  const secs = Math.round((now - t0) / 1000);
  if (!open) return <button className="btn primary" style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 40 }} onClick={() => setOpen(true)}>Journey ({i}/6)</button>;
  return (
    <div className="journey" role="dialog" aria-label="Guided 90-second journey" data-testid="journey">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>The 90-second witness</h3>
        <span className="mono" style={{ color: 'var(--muted)' }}>{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
      </div>
      <ol>{steps.map((s, k) => <li key={k} className={k < i ? 'done' : k === i ? 'now' : ''}>{s}</li>)}</ol>
      {i === 1 && props.trace && <p className="callout red" style={{ fontSize: 12.5 }}>Found by breadth-first search: a {props.trace.length}-step schedule in which both workers see stock and both reserve. Shortest possible.</p>}
      {cmp && <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 12 }}><Compare a={cmp[0]} b={cmp[1]} compact /></div>}
      {i >= 5 && props.tlcRun?.result && isCheck(props.tlcRun.result) && <p className="callout" style={{ fontSize: 12.5 }}>{props.tlcRun.result.tlc?.note}</p>}
      {verify.good && <p className="callout gold" style={{ fontSize: 12.5 }} data-testid="journey-verify">Untouched receipt: <b>{verify.good}</b>. Same receipt with the verdict edited: <b>{verify.tampered}</b>.</p>}
      {i === 6 && <p style={{ fontSize: 12.5, color: 'var(--porcelain-dim)' }}>This is evidence about a finite model with one unit of stock and two workers — not a proof about any production system.</p>}
      <div className="row">
        {i < 6 && <button className="btn primary" onClick={() => void act()} disabled={busy} data-testid="journey-next">{busy ? 'Working…' : ['Run the checker', 'Step through the witness', 'Load the fix and re-check', 'Compare the two runs', 'Run TLC', 'Verify and tamper'][i]}</button>}
        <button className="btn ghost small" onClick={() => setOpen(false)}>Hide</button>
      </div>
    </div>
  );
}
