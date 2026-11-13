import { useMemo, useState } from 'react';
import {
  DEFAULT_LIMITS, type PassName, compile, generateProgram, interpret, loadBytecode, mutateSource, reduce, runVM, sceneHash, serialize, type BCModule,
} from '../../../core/index.ts';
import { SceneCanvas } from '../SceneCanvas.tsx';
import { FAILURES, FAULT_LAB, FIXTURES, useWB } from '../workbench.ts';

const BAD: PassName[] = ['constfold', 'dce', 'BAD_cse_commute_all'];
function outcome(src: string, passes: PassName[]) {
  const c = compile(src, { passes, fixtures: FIXTURES });
  if (!c.ok) return null;
  const vm = runVM(c.bytecode!, c.data, c.limits), ref = interpret(c.program!, c.check!, c.data, c.limits);
  const o = (r: typeof vm | typeof ref) => `${sceneHash(r.scene)}|${r.fault ? `${r.fault.code}@${r.fault.span?.start}#${r.fault.frame}` : '-'}`;
  return { c, vm, ref, vmKey: o(vm), refKey: o(ref) };
}

export function Gallery() {
  const { load, setMode } = useWB();
  const observed = useMemo(() => FAILURES.map((f) => {
    const c = compile(f.source, { passes: ['constfold', 'dce', 'cse'], fixtures: FIXTURES });
    if (!c.ok) { const d = c.diagnostics.find((x) => x.severity === 'error')!; return { code: d.code, line: d.span.line, col: d.span.col, message: d.message, agree: true }; }
    const o = outcome(f.source, ['constfold', 'dce', 'cse'])!;
    const fl = o.vm.fault;
    return { code: fl?.code ?? 'none', line: fl?.span?.line ?? 0, col: fl?.span?.col ?? 0, message: fl?.message ?? 'ran to completion', agree: o.vmKey === o.refKey };
  }), []);
  const [lab, setLab] = useState<null | { vmHash: string; refHash: string; vmCmds: unknown[]; refCmds: unknown[]; reused: string[] }>(null);
  const [reduced, setReduced] = useState<null | { source: string; steps: number; tried: number; from: number }>(null);
  const [bcDemo, setBcDemo] = useState<null | { tamper: string[]; resigned: string[] }>(null);
  const [fuzz, setFuzz] = useState<null | { done: number; total: number; agree: number; faults: Record<string, number>; bad: number[]; crashes: number }>(null);

  const runLab = () => {
    const o = outcome(FAULT_LAB.source, BAD)!;
    setLab({ vmHash: sceneHash(o.vm.scene), refHash: sceneHash(o.ref.scene), vmCmds: o.vm.scene.frames[0].cmds, refCmds: o.ref.scene.frames[0].cmds, reused: o.c.passReports.flatMap((r) => r.changes).filter((x) => x.pass === 'BAD_cse_commute_all' && /sub/.test(x.detail)).map((x) => x.detail) });
  };
  const runReduce = () => {
    const red = reduce(FAULT_LAB.source, (s) => { const o = outcome(s, BAD); return !!o && o.vmKey !== o.refKey; });
    setReduced({ source: red.source, steps: red.steps, tried: red.tried, from: FAULT_LAB.source.length });
  };
  const runBc = () => {
    const c = compile(FAULT_LAB.source, { passes: ['constfold', 'dce', 'cse'] });
    const t = structuredClone(c.bytecode!);
    t.functions[t.main].code[1] = 4242;
    const unsigned = structuredClone(c.bytecode!) as BCModule & { hash?: string };
    delete unsigned.hash;
    unsigned.functions[unsigned.main].code.splice(0, 3);
    unsigned.functions[unsigned.main].spans.shift(); unsigned.functions[unsigned.main].ir.shift();
    setBcDemo({ tamper: loadBytecode(t, DEFAULT_LIMITS).errors, resigned: loadBytecode(serialize(unsigned), DEFAULT_LIMITS).errors });
  };
  const runFuzz = async (total: number) => {
    const st = { done: 0, total, agree: 0, faults: {} as Record<string, number>, bad: [] as number[], crashes: 0 };
    setFuzz({ ...st });
    for (let seed = 1; seed <= total; seed++) {
      const src = generateProgram(seed);
      for (const cfg of [[], ['constfold', 'dce', 'cse']] as PassName[][]) {
        const o = outcome(src, cfg);
        if (o && o.vmKey === o.refKey) { st.agree++; if (o.vm.fault) st.faults[o.vm.fault.code] = (st.faults[o.vm.fault.code] ?? 0) + 1; } else st.bad.push(seed);
      }
      try { if (compile(mutateSource(src, seed * 7919)).diagnostics.some((d) => d.code === 'ICE')) st.crashes++; } catch { st.crashes++; }
      st.done = seed;
      if (seed % 10 === 0) { setFuzz({ ...st }); await new Promise((r) => setTimeout(r, 0)); }
    }
    setFuzz({ ...st });
  };
  const scene = { format: 'folio-scene/0.1', title: 'lab', width: 800, height: 480, background: '#101013', frames: [] };
  return (
    <section className="pane" aria-label="Failure Gallery">
      <div className="pane-head"><h2>G · The Failure Gallery</h2><span>red-team cases · fault lab · fuzzing · every verdict computed now, in this browser</span></div>
      <div className="pane-body">
        <h3 className="section-title">Curated failures</h3>
        <p className="lede">Each file declares the diagnostic or runtime fault it must produce and where. The observed column is computed live by the compiler and the VM; for runtime faults, the reference interpreter must fault identically.</p>
        <table className="grid"><thead><tr><th>case</th><th>expected</th><th>observed</th><th>message</th><th /></tr></thead><tbody>
          {FAILURES.map((f, i) => {
            const o = observed[i], e = f.expect!;
            const ok = o.code === e.code && o.line === e.line && o.col === e.col && o.agree;
            return <tr key={f.id}><td>{f.title}</td><td>{e.code} @ {e.line}:{e.col}</td><td style={{ color: ok ? 'var(--mint)' : 'var(--oxblood)' }}>{ok ? '✓ ' : '✗ '}{o.code} @ {o.line}:{o.col}{e.kind === 'fault' ? (o.agree ? ' · VM ≡ ref' : ' · VM ≠ ref') : ''}</td><td style={{ color: 'var(--cream-dim)' }}>{o.message}</td>
              <td><button className="btn" onClick={() => { load(f.source, f.title); setMode('editorial'); }}>Open</button></td></tr>;
          })}
        </tbody></table>

        <h3 className="section-title">Fault lab · a deliberately wrong optimization</h3>
        <p className="lede"><code>BAD_cse_commute_all</code> exists only for this lab: it treats subtraction as commutative, so it "reuses" <code>a - b</code> for <code>b - a</code>. The program below is correct under every safe pass; the independent AST interpreter is what catches the miscompile.</p>
        <div className="toolbar">
          <button className="btn primary" onClick={runLab}>Compile with the bad pass and compare</button>
          <button className="btn" onClick={runReduce}>Reduce the failing program</button>
          <button className="btn" onClick={() => { load(FAULT_LAB.source, FAULT_LAB.title); setMode('duel'); }}>Open in the Duel</button>
        </div>
        {lab && <div className="cols">
          <div style={{ padding: 10 }}><div className="subhead">VM with BAD pass · {lab.vmHash.slice(0, 12)}</div><SceneCanvas scene={scene} cmds={lab.vmCmds as never} maxCss={520} label="VM output under the bad pass" /></div>
          <div style={{ padding: 10 }}><div className="subhead">Reference interpreter · {lab.refHash.slice(0, 12)}</div><SceneCanvas scene={scene} cmds={lab.refCmds as never} maxCss={520} label="Reference interpreter output" /></div>
        </div>}
        {lab && <div className="check" style={{ color: lab.vmHash === lab.refHash ? 'var(--mint)' : 'var(--oxblood)' }}>{lab.vmHash === lab.refHash ? 'No divergence detected.' : `✗ DIVERGENCE DETECTED · scene hashes differ · the bad pass made ${lab.reused.length} wrong reuse(s): ${lab.reused.slice(0, 3).join('; ')}`}</div>}
        {reduced && <><div className="subhead">Reduced reproducer · {reduced.from} → {reduced.source.length} characters · {reduced.steps} reductions accepted of {reduced.tried} tried · still diverges</div>
          <pre className="block">{reduced.source}</pre><div className="toolbar"><button className="btn" onClick={() => load(reduced.source, 'Reduced miscompile')}>Open reduced program</button></div></>}

        <h3 className="section-title">Invalid bytecode</h3>
        <p className="lede">Serialized bytecode carries a content hash; loading recomputes it, then the verifier checks opcodes, operands, jump targets and stack depth, even for a module that was re-signed after tampering.</p>
        <div className="toolbar"><button className="btn" onClick={runBc}>Tamper with bytecode and load it</button></div>
        {bcDemo && <><div className="check fail">edited one operand: {bcDemo.tamper.join('; ')}</div><div className="check fail">deleted an instruction and re-signed: {bcDemo.resigned.slice(0, 2).join('; ')}</div></>}

        <h3 className="section-title">Differential fuzzing</h3>
        <p className="lede">Seeded, type-directed program generation (<code>core/fuzz.ts</code>). Each program runs on the reference interpreter and on the VM with optimizations off and on; observable results must match exactly, faults included. Mutated sources check that the compiler never crashes.</p>
        <div className="toolbar"><button className="btn" onClick={() => runFuzz(100)}>Fuzz 100 seeds</button><button className="btn" onClick={() => runFuzz(500)}>Fuzz 500 seeds</button>
          {fuzz && <span className="badge">{fuzz.done}/{fuzz.total} seeds · {fuzz.agree} agreeing runs · {fuzz.bad.length} divergent · {fuzz.crashes} compiler crashes · faults {Object.entries(fuzz.faults).map(([k, v]) => `${k}×${v}`).join(' ')}</span>}</div>
        {fuzz && fuzz.bad.length > 0 && <div className="check fail">divergent seeds: {fuzz.bad.slice(0, 20).join(', ')}</div>}
        <div style={{ height: 30 }} />
      </div>
    </section>
  );
}
