import { useState } from 'react';
import { type PassName, SAFE_PASSES, compile, instrCount, interpret, runVM, sceneHash } from '../../../core/index.ts';
import { FIXTURES, useWB } from '../workbench.ts';
import { IRListing } from './Lowering.tsx';

const evidence = import.meta.glob('../../../evidence/benchmarks.json', { import: 'default', eager: true }) as Record<string, { env: Record<string, unknown>; rows: { example: string; instructionReduction: number; medianSpeedup: number; off: { ms: { median: number } }; on: { ms: { median: number } } }[] }>;
const BENCH = Object.values(evidence)[0];

interface Equiv { frames: number; ref: string; off: string; on: string; offSteps: number; onSteps: number; refFault: string | null; onFault: string | null }
interface Timing { off: number[]; on: number[] }
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export function Duel() {
  const { compiled, passes, setPasses, source } = useWB();
  const [fi, setFi] = useState(-1);
  const [eq, setEq] = useState<Equiv | null>(null);
  const [timing, setTiming] = useState<Timing | null>(null);
  const [busy, setBusy] = useState(false);
  if (!compiled.ir || !compiled.irOptimized) return <section className="pane"><div className="pane-head"><h2>E · The Optimization Duel</h2></div><div className="empty">Needs a program that type-checks.</div></section>;
  const before = compiled.ir, after = compiled.irOptimized;
  const idx = fi < 0 || fi >= before.functions.length ? before.main : fi;
  const afterIds = new Set(after.functions[idx].blocks.flatMap((b) => b.instrs.map((i) => i.id)));
  const changes = compiled.passReports.flatMap((r) => r.changes).filter((c) => c.fn === before.functions[idx].name);
  const touched = new Set(changes.filter((c) => c.kind === 'propagated' || c.kind === 'reused').map((c) => c.instr));
  const toggle = (p: PassName) => setPasses(SAFE_PASSES.filter((q) => (q === p ? !passes.includes(q) : passes.includes(q))));

  const check = () => {
    const off = compile(source, { passes: [], fixtures: FIXTURES }), on = compile(source, { passes, fixtures: FIXTURES });
    const a = runVM(off.bytecode!, off.data, off.limits), b = runVM(on.bytecode!, on.data, on.limits);
    const r = interpret(on.program!, on.check!, on.data, on.limits);
    setEq({ frames: r.scene.frames.length, ref: sceneHash(r.scene), off: sceneHash(a.scene), on: sceneHash(b.scene), offSteps: a.steps.reduce((x, y) => x + y, 0), onSteps: b.steps.reduce((x, y) => x + y, 0), refFault: r.fault?.code ?? null, onFault: b.fault?.code ?? null });
  };
  const measure = async () => {
    setBusy(true);
    const off = compile(source, { passes: [], fixtures: FIXTURES }), on = compile(source, { passes, fixtures: FIXTURES });
    const t: Timing = { off: [], on: [] };
    for (let i = 0; i < 26; i++) {
      for (const [k, c] of (i % 2 ? [['on', on], ['off', off]] : [['off', off], ['on', on]]) as ['off' | 'on', typeof on][]) {
        const t0 = performance.now(); runVM(c.bytecode!, c.data, c.limits); const dt = performance.now() - t0;
        if (i >= 5) t[k].push(dt);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    setTiming(t); setBusy(false);
  };
  return (
    <section className="pane" aria-label="Optimization Duel">
      <div className="pane-head"><h2>E · The Optimization Duel</h2><span>before vs after · semantics checked against the reference interpreter</span></div>
      <div className="toolbar">
        {SAFE_PASSES.map((p) => <label key={p} className="toggle"><input type="checkbox" checked={passes.includes(p)} onChange={() => toggle(p)} />{p}</label>)}
        {before.functions.length > 1 && before.functions.map((g, i) => <button key={g.name} className={`btn ${i === idx ? 'primary' : ''}`} onClick={() => setFi(i)}>{g.name}</button>)}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={check} disabled={!compiled.ok}>Check equivalence (all frames)</button>
        <button className="btn" onClick={measure} disabled={!compiled.ok || busy}>{busy ? 'Measuring…' : 'Measure in this browser'}</button>
      </div>
      <div className="stats">
        <div className="stat"><b>{instrCount(before)} → {instrCount(after)}</b><span>IR instructions (all fns)</span></div>
        {compiled.passReports.map((r) => <div className="stat" key={r.pass}><b>{r.changes.length}</b><span>{r.pass} changes · {r.before}→{r.after}</span></div>)}
        {eq && <div className="stat"><b style={{ color: eq.off === eq.ref && eq.on === eq.ref ? 'var(--mint)' : 'var(--oxblood)' }}>{eq.off === eq.ref && eq.on === eq.ref ? 'identical' : 'DIVERGENT'}</b><span>{eq.frames} frames · ref {eq.ref.slice(0, 8)} · off {eq.off.slice(0, 8)} · on {eq.on.slice(0, 8)}</span></div>}
        {eq && <div className="stat"><b>{eq.offSteps.toLocaleString()} → {eq.onSteps.toLocaleString()}</b><span>VM instructions executed (−{((1 - eq.onSteps / eq.offSteps) * 100).toFixed(1)}%)</span></div>}
        {timing && <div className="stat"><b>{median(timing.off).toFixed(3)} → {median(timing.on).toFixed(3)} ms</b><span>median of {timing.on.length} interleaved runs, this browser, now</span></div>}
      </div>
      <div className="cols" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane-body">
          <div className="subhead">Before · as lowered · struck-through = removed by a pass</div>
          <IRListing f={before.functions[idx]} mark={(id) => (afterIds.has(id) ? null : 'gone')} />
        </div>
        <div className="pane-body">
          <div className="subhead">After · [{passes.join(' → ') || 'no passes'}] · tinted = operands rewritten</div>
          <IRListing f={after.functions[idx]} mark={(id) => (touched.has(id) ? 'new' : null)} />
        </div>
      </div>
      <div className="pane-foot" style={{ maxHeight: '28vh', overflow: 'auto' }}>
        <div className="subhead">Pass log ({changes.length} changes in {before.functions[idx].name}) · every pass is followed by the IR verifier</div>
        <table className="grid"><tbody>{changes.slice(0, 300).map((c, i) => <tr key={i}><td style={{ color: 'var(--brass)' }}>{c.pass}</td><td>{c.kind}</td><td>{c.detail}</td></tr>)}</tbody></table>
        {BENCH && <>
          <div className="subhead">Recorded benchmark · evidence/benchmarks.json · {String(BENCH.env.cpu)} · node {String(BENCH.env.node)} · {String(BENCH.env.runs)} interleaved runs</div>
          <table className="grid"><thead><tr><th>example</th><th>VM instructions</th><th>median off → on</th><th>speed-up</th></tr></thead><tbody>
            {BENCH.rows.map((r) => <tr key={r.example}><td>{r.example}</td><td>−{(r.instructionReduction * 100).toFixed(1)}%</td><td>{r.off.ms.median.toFixed(3)} → {r.on.ms.median.toFixed(3)} ms</td><td style={{ color: r.medianSpeedup > 1.05 ? 'var(--mint)' : 'var(--muted)' }}>×{r.medianSpeedup.toFixed(2)}{r.medianSpeedup <= 1.05 ? ' (no meaningful change)' : ''}</td></tr>)}
          </tbody></table>
        </>}
      </div>
    </section>
  );
}
