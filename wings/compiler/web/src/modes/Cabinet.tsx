import { Fragment, useEffect, useState } from 'react';
import { BYTECODE_VERSION, COMPILER_VERSION, GRAMMAR_VERSION, IR_VERSION, RECEIPT_FORMAT, SCENE_FORMAT, type Receipt } from '../../../core/index.ts';
import { FIXTURES, api, download, routeHash, useWB } from '../workbench.ts';

const ev = import.meta.glob('../../../evidence/*.json', { import: 'default', eager: true }) as Record<string, Record<string, unknown>>;
const fuzzSummary = Object.entries(ev).find(([p]) => p.endsWith('fuzz-summary.json'))?.[1];

interface RunRow { id: string; project: string | null; createdAt: string; sceneHash: string; bytecodeHash: string; oracleAgrees: boolean; fault: { code: string } | null; passes: string[]; timingMs: { compile: number; vm: number; reference: number } }
interface Check { name: string; ok: boolean; expected?: string; actual?: string }

export function Cabinet({ project }: { project: { id: string; name: string } | null }) {
  const { compiled, source, online, label, toast, load } = useWB();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sel, setSel] = useState<{ id: string; receipt: Receipt } | null>(null);
  const [checks, setChecks] = useState<{ title: string; list: Check[] } | null>(null);
  const refresh = () => api<{ runs: RunRow[] }>('/runs?limit=50').then((r) => setRuns(r.data?.runs ?? [])).catch(() => setRuns([]));
  useEffect(() => { if (online) refresh(); }, [online]);
  const open = async (id: string) => { const r = await api<{ receipt: Receipt }>(`/runs/${id}`); setSel({ id, receipt: r.data.receipt }); setChecks(null); };
  const record = async () => {
    const used = Object.keys(FIXTURES).filter((k) => source.includes(`"${k}"`));
    const r = await api<{ ok: boolean; id: string; deduplicated: boolean; receipt: Receipt; error?: string }>('/api/runs', { method: 'POST', body: { source, project: label, projectId: project?.id, passes: compiled.passes, fixtures: used } });
    if (r.status >= 400) { toast(r.data?.error ?? 'the server rejected this program (see diagnostics)'); return; }
    toast(r.data.deduplicated ? `identical run already recorded: ${r.data.id}` : `recorded run ${r.data.id}`);
    await refresh(); await open(r.data.id);
  };
  const reproduceOnServer = async (tamper?: 'scene' | 'source' | 'bytecode') => {
    if (!sel) return;
    const receipt = structuredClone(sel.receipt);
    const bc = (await api<Record<string, unknown>>(`/api/runs/${sel.id}/bytecode`)).data as { consts: unknown[] };
    if (tamper === 'scene') receipt.sceneHash = receipt.sceneHash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    if (tamper === 'source') receipt.source += '\n// one innocent-looking comment';
    if (tamper === 'bytecode') bc.consts[0] = 4242;
    const r = await api<{ reproduced: boolean; checks: Check[] }>('/api/reproduce', { method: 'POST', body: { receipt, bytecode: bc } });
    setChecks({ title: tamper ? `Tampered (${tamper}) → ${r.data.reproduced ? 'ACCEPTED (bad!)' : 'rejected'}` : r.data.reproduced ? 'Reproduced from scratch on the server' : 'Did not reproduce', list: r.data.checks });
  };
  const importBundle = async (file: File) => {
    if (file.size > 2_000_000) { toast('bundle over 2 MB: refused'); return; }
    let body: unknown;
    try { body = JSON.parse(await file.text()); } catch { toast('not a JSON bundle'); return; }
    const r = await api<{ imported: boolean; project?: { id: string; name: string; head: { source: string } }; checks: Check[]; error?: string }>('/api/import', { method: 'POST', body });
    setChecks({ title: r.data?.imported ? 'Imported: the bundle reproduced here' : `Import refused${r.data?.error ? `: ${r.data.error}` : ''}`, list: r.data?.checks ?? [] });
    if (r.data?.imported && r.data.project) { load(r.data.project.head.source, r.data.project.name); history.replaceState(null, '', routeHash({ mode: 'cabinet', project: r.data.project.id })); }
  };
  const localHash = compiled.bytecode?.hash;
  return (
    <section className="pane" aria-label="Proof Cabinet">
      <div className="pane-head"><h2>H · The Proof Cabinet</h2><span>receipts · reproduction · tamper evidence · measured results</span></div>
      <div className="pane-body">
        <div className="stats">
          <div className="stat"><b>{COMPILER_VERSION}</b><span>compiler</span></div><div className="stat"><b>{GRAMMAR_VERSION}</b><span>grammar</span></div>
          <div className="stat"><b>{IR_VERSION}</b><span>ir</span></div><div className="stat"><b>{BYTECODE_VERSION}</b><span>bytecode</span></div>
          <div className="stat"><b>{SCENE_FORMAT}</b><span>scene</span></div><div className="stat"><b>{RECEIPT_FORMAT}</b><span>receipt</span></div>
        </div>
        <h3 className="section-title">This program</h3>
        <p className="lede">Recording sends the source to the loopback server, which compiles it again in its own process, runs the VM and the reference interpreter, and stores a content-addressed receipt in SQLite. The browser's bytecode hash below should equal the server's.</p>
        <div className="toolbar">
          <button className="btn primary" onClick={record} disabled={!online || !compiled.ok}>{online ? 'Record run on the server' : 'Server offline'}</button>
          <span className="badge">browser bytecode {localHash ? localHash.slice(0, 16) : '—'}</span>
          {sel && localHash && <span className={`badge ${sel.receipt.bytecodeHash === localHash ? 'mint' : ''}`}>{sel.receipt.bytecodeHash === localHash ? '✓ browser and server compiled the same bytes' : 'selected run is a different program or configuration'}</span>}
          <label className="btn">Import bundle…<input type="file" accept="application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && importBundle(e.target.files[0])} /></label>
        </div>
        <h3 className="section-title">Pipeline DAG of the current compile</h3>
        <div className="toolbar" style={{ gap: 4 }}>{compiled.stages.map((s, i) => <span key={s.stage} className={`chip ${s.ok ? 'ok' : 'bad'}`} title={`in ${s.inputHash}\nout ${s.outputHash}`}>{i ? '→ ' : ''}{s.stage} {s.outputHash ? s.outputHash.slice(0, 6) : '✗'}</span>)}</div>
        <div className="cols">
          <div>
            <div className="subhead">Recorded runs ({runs.length})</div>
            <table className="grid"><thead><tr><th>run</th><th>project</th><th>oracle</th><th>passes</th><th>when</th></tr></thead><tbody>
              {runs.map((r) => <tr key={r.id} className={`click ${sel?.id === r.id ? 'cur' : ''}`} onClick={() => open(r.id)}><td>{r.id}</td><td>{r.project ?? '—'}</td><td style={{ color: r.oracleAgrees ? 'var(--mint)' : 'var(--oxblood)' }}>{r.oracleAgrees ? 'agrees' : 'DIVERGES'}{r.fault ? ` · ${r.fault.code}` : ''}</td><td>{r.passes.join('+') || 'none'}</td><td>{new Date(r.createdAt).toLocaleTimeString()}</td></tr>)}
              {!runs.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>{online ? 'No runs yet: record one.' : 'Start the API server (npm run server) to keep run records.'}</td></tr>}
            </tbody></table>
          </div>
          <div>
            {sel ? <>
              <div className="subhead">Receipt {sel.id}</div>
              <dl className="kv">
                {(['sourceHash', 'fixtureHash', 'bytecodeHash', 'traceHash', 'sceneHash', 'digest'] as const).map((k) => <Fragment key={k}><dt>{k}</dt><dd>{sel.receipt[k]}</dd></Fragment>)}
                <dt>oracle</dt><dd>{sel.receipt.oracle.engine}: {sel.receipt.oracle.sceneHash.slice(0, 16)} · {sel.receipt.oracle.status ?? (sel.receipt.oracle.agrees ? 'agree' : 'diverge')}</dd>
                <dt>optimizations</dt><dd>{sel.receipt.optimizations.join(', ') || 'none'}</dd>
                <dt>timing</dt><dd>compile {sel.receipt.timingMs.compile} ms · VM {sel.receipt.timingMs.vm} ms · reference {sel.receipt.timingMs.reference} ms</dd>
                <dt>commit</dt><dd>{sel.receipt.commit ?? '—'}</dd>
              </dl>
              <div className="toolbar">
                <button className="btn primary" onClick={() => reproduceOnServer()}>Reproduce</button>
                <button className="btn" onClick={() => reproduceOnServer('scene')}>Tamper: scene hash</button>
                <button className="btn" onClick={() => reproduceOnServer('source')}>Tamper: source</button>
                <button className="btn" onClick={() => reproduceOnServer('bytecode')}>Tamper: bytecode</button>
                <button className="btn" onClick={async () => download(`paper-tiger-run-${sel.id}.json`, (await api(`/api/runs/${sel.id}/bundle`)).data)}>Export bundle</button>
                <button className="btn" onClick={() => download(`receipt-${sel.id}.json`, sel.receipt)}>Receipt</button>
              </div>
              <pre className="block">npm run reproduce -- receipt-{sel.id}.json</pre>
            </> : <div className="empty">Select a run to see its receipt.</div>}
            {checks && <><div className="subhead">{checks.title}</div>{checks.list.map((c, i) => <div key={i} className={`check ${c.ok ? 'pass' : 'fail'}`}>{c.name}{!c.ok && c.actual ? ` (got ${String(c.actual).slice(0, 40)})` : ''}</div>)}</>}
          </div>
        </div>
        {fuzzSummary && <><h3 className="section-title">Recorded evidence</h3><p className="lede">From <code>evidence/fuzz-summary.json</code>, produced by <code>npm run fuzz</code> (not by this page).</p><pre className="block">{JSON.stringify(fuzzSummary, null, 2)}</pre></>}
        <div style={{ height: 30 }} />
      </div>
    </section>
  );
}
