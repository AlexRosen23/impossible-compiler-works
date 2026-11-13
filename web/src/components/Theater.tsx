// The Interleaving Theater: process lanes over logical steps, a trace scrubber, manual
// one-process-at-a-time scheduling over the explored graph, and saved schedules.
import { useMemo, useState } from 'react';
import type { CheckResult, Trace, TraceStep } from '../types';
import { show } from './Rail';

interface Props {
  result: CheckResult;
  trace: Trace | null;
  cursor: number;
  setCursor: (n: number) => void;
  onSelectState: (id: number) => void;
  selected: number | null;
}

interface Window { reader: string; variable: string; readAt: number; writer: string; writeAt: number; useAt: number }

/** Interference windows computed from real transitions: P reads X, Q writes X, then P acts again. */
export function interference(result: CheckResult, steps: TraceStep[]): Window[] {
  const out: Window[] = [];
  const meta = new Map(result.model.actions.map((a) => [a.label, a]));
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i].action ? meta.get(steps[i].action!) : undefined;
    if (!a) continue;
    for (const x of a.reads) {
      if (a.writes.includes(x)) continue; // read-modify-write in one atomic step is not a window
      for (let j = i + 1; j < steps.length; j++) {
        const b = steps[j].action ? meta.get(steps[j].action!) : undefined;
        if (!b) continue;
        if (b.process === a.process) break;
        if (b.writes.includes(x) && steps[j].changes.some((c) => c.variable === x)) {
          const k = steps.findIndex((s, idx) => idx > j && s.process === a.process);
          if (k > 0) out.push({ reader: a.process, variable: x, readAt: i, writer: b.process, writeAt: j, useAt: k });
          break;
        }
      }
    }
  }
  return out;
}

export function Theater({ result, trace, cursor, setCursor, onSelectState, selected }: Props) {
  const [manual, setManual] = useState<{ ids: number[]; acts: number[] } | null>(null);
  const [schedText, setSchedText] = useState('');
  const [msg, setMsg] = useState('');
  const procs = result.model.processes;
  const meta = useMemo(() => new Map(result.model.actions.map((a) => [a.label, a])), [result]);

  const steps: TraceStep[] = useMemo(() => {
    if (manual && result.states) {
      return manual.ids.map((id, i) => {
        const a = i ? result.model.actions[manual.acts[i - 1]] : null;
        const prev = i ? result.states![manual.ids[i - 1]] : null;
        const st = result.states![id];
        return {
          step: i, stateId: id, state: st, action: a?.label ?? null, actionIndex: i ? manual.acts[i - 1] : null, process: a?.process ?? null, guard: a?.guard ?? null,
          changes: prev ? Object.keys(st).filter((k) => prev[k] !== st[k]).map((k) => ({ variable: k, from: prev[k], to: st[k] })) : [],
        };
      });
    }
    return trace?.steps ?? [];
  }, [manual, trace, result]);
  const windows = useMemo(() => interference(result, steps), [result, steps]);

  const startManual = () => {
    const init = selected ?? result.graph?.nodes.find((n) => n.flags & 1)?.id ?? 0;
    setManual({ ids: [init], acts: [] });
    setCursor(0);
    onSelectState(init);
  };
  const advance = (proc: string, edge: { to: number; action: number }) => {
    if (!manual) return;
    void proc;
    const ids = [...manual.ids.slice(0, cursor + 1), edge.to];
    const acts = [...manual.acts.slice(0, cursor), edge.action];
    setManual({ ids, acts });
    setCursor(ids.length - 1);
    onSelectState(edge.to);
  };
  const current = steps[cursor];
  const outgoing = manual && current ? (result.graph?.edges ?? []).filter((e) => e.from === current.stateId) : [];

  const saveSchedule = () => {
    const sched = steps.slice(1).map((s) => s.stutter ? '(stutter)' : s.action);
    const text = JSON.stringify({ model: result.model.name, schedule: sched });
    setSchedText(text);
    try { localStorage.setItem(`witness-schedule:${result.model.name}`, text); } catch { /* storage unavailable */ }
    setMsg(`Saved a ${sched.length}-step schedule (also kept in this browser).`);
  };
  const replaySchedule = () => {
    let text = schedText;
    if (!text) { try { text = localStorage.getItem(`witness-schedule:${result.model.name}`) ?? ''; } catch { text = ''; } }
    let sched: string[];
    try { sched = JSON.parse(text).schedule; if (!Array.isArray(sched)) throw new Error(); } catch { setMsg('Paste a schedule JSON first: {"schedule": ["A.read", ...]}'); return; }
    const init = result.graph?.nodes.find((n) => n.flags & 1)?.id ?? 0;
    const ids = [init], acts: number[] = [];
    for (let i = 0; i < sched.length; i++) {
      if (sched[i] === '(stutter)') continue;
      const ai = result.model.actions.findIndex((a) => a.label === sched[i]);
      const e = (result.graph?.edges ?? []).find((x) => x.from === ids[ids.length - 1] && x.action === ai);
      if (!e) { setMsg(`Step ${i + 1}: '${String(sched[i]).slice(0, 40)}' is not enabled in s${ids[ids.length - 1]} — the schedule is impossible in this model.`); break; }
      ids.push(e.to); acts.push(e.action);
    }
    setManual({ ids, acts });
    setCursor(ids.length - 1);
    onSelectState(ids[ids.length - 1]);
    if (!msg.startsWith('Step')) setMsg(`Replayed ${acts.length} step(s) over the explored transition relation.`);
  };

  if (!steps.length && !manual) {
    return (
      <div>
        <p className="callout">No witness to show: every property holds in this bounded model, or no run yet. You can still schedule the processes yourself.</p>
        <button className="btn" onClick={startManual} disabled={!result.graph}>Schedule processes by hand</button>
      </div>
    );
  }

  return (
    <div data-testid="theater">
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="field" style={{ flex: 1, minWidth: 220 }}>
          <span>{manual ? 'Hand-built schedule' : `Witness for ${trace?.property}`} — logical step {cursor} of {steps.length - 1}</span>
          <input type="range" min={0} max={Math.max(0, steps.length - 1)} value={cursor} onChange={(e) => { const c = Number(e.target.value); setCursor(c); const id = steps[c]?.stateId; if (id !== undefined && id >= 0) onSelectState(id); }} aria-label="Trace scrubber: logical step" data-testid="trace-scrubber" />
        </label>
        <button className="btn small" onClick={() => { const c = Math.max(0, cursor - 1); setCursor(c); if (steps[c].stateId >= 0) onSelectState(steps[c].stateId); }} aria-label="Previous step">◀</button>
        <button className="btn small" onClick={() => { const c = Math.min(steps.length - 1, cursor + 1); setCursor(c); if (steps[c].stateId >= 0) onSelectState(steps[c].stateId); }} aria-label="Next step">▶</button>
        {manual ? <button className="btn small" onClick={() => { setManual(null); setCursor(0); setMsg(''); }}>Back to witness</button> : <button className="btn small" onClick={startManual}>Schedule by hand</button>}
        <button className="btn small" onClick={saveSchedule}>Save schedule</button>
        <button className="btn small" onClick={replaySchedule}>Replay schedule</button>
      </div>
      {msg && <p className="callout gold" role="status">{msg}</p>}
      {manual && current && (
        <div className="callout" style={{ marginBottom: 10 }}>
          <b>Advance one process:</b>{' '}
          {procs.map((p) => {
            const es = outgoing.filter((e) => result.model.actions[e.action].process === p);
            return (
              <span key={p} style={{ marginRight: 12 }}>
                <span style={{ color: 'var(--indigo)' }}>{p}</span>:{' '}
                {es.length ? es.map((e, i) => <button key={i} className="btn small" style={{ marginRight: 4 }} onClick={() => advance(p, e)}>{result.model.actions[e.action].label.slice(p.length + 1)}</button>) : <span style={{ color: 'var(--muted)' }}>blocked</span>}
              </span>
            );
          })}
          {outgoing.length === 0 && <span style={{ color: 'var(--vermilion)' }}> no process can move.</span>}
        </div>
      )}
      {windows.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {windows.map((w, i) => (
            <div key={i} className="window">Interference window: {w.reader} read <code>{w.variable}</code> at step {w.readAt}; {w.writer} changed it at step {w.writeAt}; {w.reader} acted again at step {w.useAt} on the stale value.</div>
          ))}
        </div>
      )}
      <div className="lanes" style={{ gridTemplateColumns: `56px repeat(${procs.length}, minmax(170px, 1fr))` }} role="table" aria-label="Process lanes: one column per process, one row per logical step">
        <div role="row" style={{ display: 'contents' }}>
          <div className="lane-head" role="columnheader">step</div>
          {procs.map((p) => <div key={p} className="lane-head" role="columnheader">{p}</div>)}
        </div>
        {steps.map((s, i) => (
          <div key={i} style={{ display: 'contents' }} role="row">
            <div className={`lane-cell step-no ${i === cursor ? 'current' : ''} ${i > cursor ? 'future' : ''}`} role="cell">
              {i}{trace?.loopStart === i && !manual ? <div title="the loop returns here" style={{ color: 'var(--indigo)' }}>↺</div> : null}
            </div>
            {procs.map((p) => {
              const mine = s.process === p;
              const m = mine && s.action ? meta.get(s.action) : undefined;
              return (
                <div key={p} role="cell" className={`lane-cell ${mine ? 'active' : ''} ${i === cursor ? 'current' : ''} ${i > cursor ? 'future' : ''}`} onClick={() => { setCursor(i); if (s.stateId >= 0) onSelectState(s.stateId); }} style={{ cursor: 'pointer' }}>
                  {i === 0 && p === procs[0] ? <span className="guard">initial state</span> : null}
                  {s.stutter && p === procs[0] ? <span className="guard">stutters forever (no fair process must move)</span> : null}
                  {mine && (
                    <>
                      <div className="act">{s.action!.slice(p.length + 1)}</div>
                      <div className="guard">enabled by: {s.guard}</div>
                      {s.changes.map((c) => <div key={c.variable} className="chg">{c.variable}: {show(c.from)} → {show(c.to)}</div>)}
                      {m && <div className="rw">reads {m.reads.join(', ') || '—'} · writes {m.writes.join(', ') || '—'}</div>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>Schedule JSON</summary>
        <textarea className="input" style={{ width: '100%', minHeight: 60 }} value={schedText} onChange={(e) => setSchedText(e.target.value)} aria-label="Schedule JSON" />
      </details>
    </div>
  );
}
