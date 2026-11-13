// The Witness Archive: immutable runs, aligned comparison of two runs, receipts
// (export, verify, tamper demonstration), annotations and the HTML report.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CheckResult, RunView, Trace } from '../types';
import { StatusChip } from './Panels';
import { show } from './Rail';

type RunsList = Awaited<ReturnType<typeof api.runs>>['runs'];

function firstTrace(r: CheckResult | null): Trace | null {
  return r?.properties.find((p) => p.trace && p.status === 'VIOLATED')?.trace ?? null;
}

export function Compare({ a, b, compact }: { a: RunView; b: RunView; compact?: boolean }) {
  const ra = a.result as CheckResult, rb = b.result as CheckResult;
  const ta = firstTrace(ra), tb = firstTrace(rb);
  const names = [...new Set([...ra.properties.map((p) => p.name), ...rb.properties.map((p) => p.name)])];
  const n = Math.max(ta?.steps.length ?? 0, tb?.steps.length ?? 0);
  const bad = (r: CheckResult) => r.graph?.nodes.filter((x) => x.flags & (2 | 4 | 64)).length ?? 0;
  return (
    <div data-testid="compare" className={compact ? 'compact' : ''}>
      <div className="split">
        {[a, b].map((r) => {
          const c = r.result as CheckResult;
          return (
            <div key={r.id} className="stat" style={{ padding: 10 }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 16 }}>{r.model.title}</div>
              <div className="mono" style={{ color: 'var(--muted)' }}>{r.id} · rev {r.revision.rev}</div>
              <div className={`verdict ${c.verdict === 'VIOLATION_FOUND' ? 'bad' : c.verdict === 'INCOMPLETE' ? 'warn' : 'ok'}`}>{c.verdict}</div>
              <div className="mono">{c.stats.states} reachable states · {bad(c)} bad · {c.stats.edges} transitions</div>
            </div>
          );
        })}
      </div>
      <p className="callout gold" data-testid="compare-summary">The repaired model reaches {(rb.stats.states)} states instead of {ra.stats.states}, and {bad(rb)} bad states instead of {bad(ra)}: the reachable set changed because the transition relation changed, not because a line was hidden.</p>
      {!compact && <table className="grid">
        <thead><tr><th>property</th><th>{a.model.slug}</th><th>{b.model.slug}</th></tr></thead>
        <tbody>{names.map((nm) => (
          <tr key={nm}><td className="mono">{nm}</td>
            <td>{(() => { const p = ra.properties.find((x) => x.name === nm); return p ? <StatusChip s={p.status} /> : '—'; })()}</td>
            <td>{(() => { const p = rb.properties.find((x) => x.name === nm); return p ? <StatusChip s={p.status} /> : '—'; })()}</td></tr>
        ))}</tbody>
      </table>}
      {n > 0 && !compact && (
        <>
          <div className="section-title">witnesses aligned by logical step</div>
          <table className="grid">
            <thead><tr><th>step</th><th>{a.model.slug}: action</th><th>changes</th><th>{b.model.slug}: action</th><th>changes</th></tr></thead>
            <tbody>{Array.from({ length: n }, (_, i) => {
              const sa = ta?.steps[i], sb = tb?.steps[i];
              return (
                <tr key={i}><td className="mono">{i}</td>
                  <td className="mono">{sa ? (sa.stutter ? '(stutter)' : sa.action ?? '(initial)') : ''}</td>
                  <td className="mono" style={{ color: 'var(--gold)' }}>{sa?.changes.map((c) => `${c.variable}: ${show(c.from)}→${show(c.to)}`).join(', ')}</td>
                  <td className="mono">{sb ? (sb.stutter ? '(stutter)' : sb.action ?? '(initial)') : tb ? '' : i === 0 ? '(no witness: no violation)' : ''}</td>
                  <td className="mono" style={{ color: 'var(--gold)' }}>{sb?.changes.map((c) => `${c.variable}: ${show(c.from)}→${show(c.to)}`).join(', ')}</td></tr>
              );
            })}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function Archive({ run, onOpenRun }: { run: RunView | null; onOpenRun: (id: string) => void }) {
  const [runs, setRuns] = useState<RunsList>([]);
  const [pick, setPick] = useState<string[]>([]);
  const [cmp, setCmp] = useState<[RunView, RunView] | null>(null);
  const [verify, setVerify] = useState<Awaited<ReturnType<typeof api.verify>> | null>(null);
  const [receiptText, setReceiptText] = useState('');
  const [note, setNote] = useState('');
  const [prop, setProp] = useState('');
  const [annotations, setAnnotations] = useState(run?.annotations ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.runs(200).then((r) => setRuns(r.runs)); }, [run?.id, run?.status]);
  useEffect(() => { setAnnotations(run?.annotations ?? []); setVerify(null); setReceiptText(''); }, [run?.id]);

  const loadReceipt = async () => {
    if (!run) return;
    const r = await api.receipt(run.id);
    setReceiptText(JSON.stringify(r, null, 2));
    return r;
  };
  const doVerify = async (obj?: unknown) => {
    setBusy(true);
    try {
      let rec = obj;
      if (rec === undefined) { try { rec = JSON.parse(receiptText); } catch { setVerify({ ok: false, verdict: 'REJECTED', checks: [{ name: 'json', ok: false, detail: 'not valid JSON' }] }); return; } }
      setVerify(await api.verify(rec));
    } finally { setBusy(false); }
  };
  const tamper = async () => {
    const r = (receiptText ? JSON.parse(receiptText) : await loadReceipt()) as Record<string, any>;
    // flip the verdict to the comforting answer — exactly what a forger would do
    r.result.verdict = r.result.verdict === 'NO_VIOLATION_IN_BOUNDED_MODEL' ? 'VIOLATION_FOUND' : 'NO_VIOLATION_IN_BOUNDED_MODEL';
    if (r.result.complete === false) r.result.complete = true;
    setReceiptText(JSON.stringify(r, null, 2));
    await doVerify(r);
  };
  const download = async () => {
    const r = await loadReceipt();
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `witness-receipt-${run!.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const compare = async () => {
    const [x, y] = await Promise.all(pick.map((id) => api.run(id)));
    setCmp([x, y]);
  };

  const check = run?.result && (run.result as CheckResult).properties ? (run.result as CheckResult) : null;
  return (
    <div data-testid="archive">
      {run && check && (
        <div className="split">
          <div>
            <div className="section-title">receipt for {run.id}</div>
            <p style={{ margin: '0 0 8px', color: 'var(--porcelain-dim)' }}>Digest <code>{run.receipt_digest?.slice(0, 24)}…</code> · model rev {run.revision.rev} (sha256 <code>{run.revision.source_sha256.slice(0, 12)}…</code>) · bounds {Object.entries(run.bounds).map(([k, v]) => `${k}=${v}`).join(', ')}</p>
            <div className="row">
              <button className="btn" onClick={download} data-testid="download-receipt">Export receipt (JSON)</button>
              <a className="btn" href={`/api/runs/${run.id}/report.html`} download>Export HTML report</a>
              <button className="btn" onClick={() => void (async () => { await loadReceipt(); })()}>Show receipt</button>
              <button className="btn" onClick={() => void doVerify()} disabled={!receiptText || busy} data-testid="verify-receipt">Verify</button>
              <button className="btn danger" onClick={() => void tamper()} disabled={busy} data-testid="tamper-receipt">Tamper &amp; verify</button>
            </div>
            <textarea className="input" style={{ width: '100%', minHeight: 140, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11.5 }} value={receiptText} onChange={(e) => setReceiptText(e.target.value)} placeholder="Paste a receipt JSON here, or click Show receipt" aria-label="Receipt JSON" />
            {verify && (
              <div role="status" data-testid="verify-result">
                <div className={`verdict ${verify.ok ? 'ok' : 'bad'}`}>{verify.verdict}</div>
                <table className="grid"><tbody>{verify.checks.map((c, i) => <tr key={i}><td>{c.ok ? '✓' : '✗'}</td><td className="mono">{c.name}</td><td style={{ color: c.ok ? 'var(--porcelain-dim)' : 'var(--vermilion)' }}>{c.detail}</td></tr>)}</tbody></table>
              </div>
            )}
          </div>
          <div>
            <div className="section-title">annotations — why this matters, what is not modelled</div>
            <ul className="list" style={{ marginBottom: 8 }}>{annotations.map((a) => <li key={a.id} style={{ fontSize: 12.5 }}><b className="mono">{a.property}</b>: {a.text}</li>)}</ul>
            <div className="row">
              <select className="field" aria-label="Property to annotate" value={prop} onChange={(e) => setProp(e.target.value)} style={{ background: 'var(--void-2)', border: '1px solid var(--line)', borderRadius: 6, padding: 4 }}>
                <option value="">(whole run)</option>{check.properties.map((p) => <option key={p.name}>{p.name}</option>)}
              </select>
              <input className="field" style={{ flex: 1, background: 'var(--void-2)', border: '1px solid var(--line)', borderRadius: 6, padding: 5 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. models one unit of stock; payment and shipping are not modelled" aria-label="Annotation text" maxLength={2000} />
              <button className="btn" disabled={!note.trim()} onClick={() => void api.annotate(run.id, prop || 'run', note).then((r) => { setAnnotations(r.annotations); setNote(''); })}>Save note</button>
            </div>
          </div>
        </div>
      )}
      <div className="section-title">all runs (immutable) — tick two to compare</div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="btn" disabled={pick.length !== 2} onClick={() => void compare()} data-testid="compare-runs">Compare selected ({pick.length}/2)</button>
      </div>
      <div style={{ maxHeight: 300, overflow: 'auto' }}>
        <table className="grid">
          <thead><tr><th></th><th>run</th><th>model</th><th>kind</th><th>status</th><th>verdict</th><th>states</th><th>finished</th><th></th></tr></thead>
          <tbody>{runs.map((r) => (
            <tr key={r.id} className={r.id === run?.id ? 'sel' : ''}>
              <td><input type="checkbox" aria-label={`Select ${r.id} for comparison`} checked={pick.includes(r.id)} disabled={r.kind === 'mutation' || r.status !== 'done'} onChange={(e) => setPick((p) => (e.target.checked ? [...p, r.id].slice(-2) : p.filter((x) => x !== r.id)))} /></td>
              <td className="mono">{r.id.slice(4, 16)}</td><td>{r.slug} <span style={{ color: 'var(--muted)' }}>r{r.rev}</span></td><td>{r.kind}</td><td>{r.status}</td>
              <td>{r.verdict ? <StatusChip s={r.verdict === 'VIOLATION_FOUND' ? 'VIOLATED' : r.verdict === 'INCOMPLETE' ? 'INCOMPLETE' : r.verdict === 'ERROR' ? 'ERROR' : 'VERIFIED_BOUNDED'} /> : '—'}</td>
              <td className="mono">{r.states ?? '—'}</td><td className="mono" style={{ color: 'var(--muted)' }}>{r.finished_at?.slice(11, 19) ?? ''}</td>
              <td>{r.kind !== 'mutation' && r.status === 'done' && <button className="btn small" onClick={() => onOpenRun(r.id)}>Open</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {cmp && <div style={{ marginTop: 12 }}><Compare a={cmp[0]} b={cmp[1]} /></div>}
    </div>
  );
}
