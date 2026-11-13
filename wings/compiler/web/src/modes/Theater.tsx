import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DebugSession, disassemble } from '../../../core/index.ts';
import { SceneCanvas } from '../SceneCanvas.tsx';
import { useWB } from '../workbench.ts';

export function Theater() {
  const { compiled, breakpoints, setDebugLine, select } = useWB();
  const [frame, setFrame] = useState(0);
  const [, setTick] = useState(0);
  const [maxSeen, setMaxSeen] = useState(0);
  const [proof, setProof] = useState<null | { step: number; viaCheckpoint: string; viaFreshReplay: string; equal: boolean }>(null);
  const [watches, setWatches] = useState<string[]>([]);
  const [watchInput, setWatchInput] = useState('');
  const frames = compiled.check?.scene?.frames ?? 1;
  const session = useMemo(() => (compiled.ok && compiled.bytecode ? new DebugSession(compiled.bytecode, compiled.data, compiled.limits, Math.min(frame, frames - 1)) : null), [compiled, frame, frames]);
  const refresh = useCallback(() => {
    if (!session) return;
    setTick((t) => t + 1);
    setMaxSeen((m) => Math.max(m, session.vm.steps));
    setDebugLine(session.position().line || null);
  }, [session, setDebugLine]);
  useEffect(() => { setMaxSeen(0); setProof(null); refresh(); }, [session]);
  useEffect(() => () => setDebugLine(null), [setDebugLine]);
  const act = useCallback((f: (s: DebugSession) => void) => { if (session) { f(session); refresh(); } }, [session, refresh]);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.cm-editor')) return;
      if (e.key === 'F10') { e.preventDefault(); act((s) => s.stepOver()); }
      else if (e.key === 'F11' && e.shiftKey) { e.preventDefault(); act((s) => s.stepOut()); }
      else if (e.key === 'F11') { e.preventDefault(); act((s) => s.stepIn()); }
      else if (e.key === 'F8') { e.preventDefault(); act((s) => s.continue(breakpoints)); }
      else if (e.key === '.') act((s) => s.stepInstruction());
      else if (e.key === ',') act((s) => s.goto(s.vm.steps - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, breakpoints]);

  if (!session || !compiled.bytecode) return <section className="pane"><div className="pane-head"><h2>F · The Bytecode Theater</h2></div><div className="empty">The debugger runs verified bytecode: fix the diagnostics first.</div></section>;
  const pos = session.position();
  const vm = session.vm;
  const fnIndex = vm.frames[vm.frames.length - 1].fn;
  const dis = disassemble(compiled.bytecode, fnIndex);
  const stack = vm.describe();
  const opt = compiled.irOptimized!.functions[fnIndex], low = compiled.ir!.functions[fnIndex];
  const watchValue = (name: string) => {
    const top = stack[0];
    const slot = top.slots.find((s) => s.name === name);
    if (slot) return slot.value;
    const mov = opt.blocks.flatMap((b) => b.instrs).find((i) => i.op === 'mov' && i.meta.binding === name);
    if (mov && mov.dst !== null) return `${top.regs[mov.dst]} (reg %${mov.dst})`;
    if (low.blocks.some((b) => b.instrs.some((i) => i.meta.binding === name))) return 'optimized away (constant- or copy-propagated): turn the passes off in the Duel to watch it';
    return 'not in scope in this frame';
  };
  const scene = compiled.check?.scene ? { format: 'folio-scene/0.1', ...compiled.check.scene, frames: [] } : null;
  return (
    <section className="pane" aria-label="Bytecode Theater" ref={root}>
      <div className="pane-head"><h2>F · The Bytecode Theater</h2><span>the real VM, one instruction at a time · F10 over · F11 in · ⇧F11 out · F8 continue · . step · , back</span></div>
      <div className="toolbar">
        <button className="btn" onClick={() => act((s) => s.goto(0))}>⟲ Restart</button>
        <button className="btn" onClick={() => act((s) => s.goto(Math.max(0, s.vm.steps - 1)))} disabled={pos.step === 0}>◂ Back</button>
        <button className="btn" onClick={() => act((s) => s.stepInstruction())} disabled={vm.done}>Step instr</button>
        <button className="btn" onClick={() => act((s) => s.stepIn())} disabled={vm.done}>Step in</button>
        <button className="btn" onClick={() => act((s) => s.stepOver())} disabled={vm.done}>Step over</button>
        <button className="btn" onClick={() => act((s) => s.stepOut())} disabled={vm.done}>Step out</button>
        <button className="btn primary" onClick={() => act((s) => s.continue(breakpoints))} disabled={vm.done}>Continue ▸ {breakpoints.size ? `(${breakpoints.size} bp)` : '(to end)'}</button>
        {frames > 1 && <label className="toggle">frame <input type="number" min={0} max={frames - 1} value={frame} onChange={(e) => setFrame(Math.max(0, Math.min(frames - 1, Number(e.target.value))))} style={{ width: 60, background: 'transparent', border: 0 }} /></label>}
      </div>
      <div className="transport">
        <span className="t">step {pos.step.toLocaleString()}</span>
        <input type="range" min={0} max={Math.max(maxSeen, pos.step)} value={pos.step} onChange={(e) => act((s) => s.goto(Number(e.target.value)))} aria-label="Time travel: execution step" />
        <button className="btn" onClick={() => setProof(session.proveReplay(pos.step))}>Prove replay at this step</button>
        {proof && <span className={`badge ${proof.equal ? 'mint' : 'ox'}`} title={`checkpoint ${proof.viaCheckpoint}\nfresh ${proof.viaFreshReplay}`}>{proof.equal ? '✓' : '✗'} step {proof.step}: rewind state {proof.viaCheckpoint.slice(0, 10)} {proof.equal ? '=' : '≠'} fresh replay {proof.viaFreshReplay.slice(0, 10)}</span>}
      </div>
      <div className="stats">
        <div className="stat"><b>{pos.fn}</b><span>function · depth {pos.depth}</span></div>
        <div className="stat"><b>pc {pos.pc}</b><span>source line {pos.line}</span></div>
        <div className="stat"><b style={{ color: vm.status === 'fault' ? 'var(--oxblood)' : vm.status === 'halted' ? 'var(--mint)' : undefined }}>{vm.status}</b><span>status</span></div>
        <div className="stat"><b>{vm.steps.toLocaleString()} / {compiled.limits.fuelPerFrame.toLocaleString()}</b><span>fuel used</span></div>
        <div className="stat"><b>{vm.iterations}</b><span>loop iterations</span></div>
        <div className="stat"><b>{vm.scene.cmds.length}</b><span>shapes so far</span></div>
        <div className="stat"><b>{session.checkpoints.length}</b><span>checkpoints (every {session.interval})</span></div>
      </div>
      {vm.fault && <div className="toolbar" style={{ color: '#e19a95' }}>Fault {vm.fault.code}: {vm.fault.message} {vm.fault.span && <button className="btn" onClick={() => select(vm.fault!.span!)}>line {vm.fault.span.line}:{vm.fault.span.col}</button>}</div>}
      <div className="cols" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane-body">
          <div className="subhead">Bytecode · {pos.fn}</div>
          <table className="grid"><tbody>
            {dis.map((d) => <tr key={d.pc} className={d.pc === pos.pc ? 'cur' : ''} ref={d.pc === pos.pc ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}><td style={{ width: 20, color: 'var(--brass)' }}>{d.pc === pos.pc ? '▶' : ''}</td><td>{d.pc}</td><td>{d.text}</td><td style={{ color: 'var(--muted)' }}>{d.effect}</td><td>{d.line}</td></tr>)}
          </tbody></table>
        </div>
        <div className="pane-body dbg-stack">
          <div className="subhead">Call stack, locals and operand stack</div>
          {stack.map((f, i) => (
            <div className="dbg-frame" key={i}>
              <div><span className="fn">{f.fn}</span> · pc {f.pc} · line {f.line}</div>
              <table className="grid"><tbody>
                {f.slots.map((s, k) => <tr key={k}><td>${k} {s.name}</td><td>{s.value}</td></tr>)}
                <tr><td style={{ color: 'var(--muted)' }}>operand stack</td><td>[{f.stack.join(', ')}]</td></tr>
              </tbody></table>
              {i === 0 && <details><summary style={{ color: 'var(--muted)', cursor: 'pointer' }}>registers ({f.regs.length})</summary><pre className="block">{f.regs.map((r, k) => `%${k} = ${r}`).join('\n')}</pre></details>}
            </div>
          ))}
          <div className="subhead">Watches</div>
          <div className="toolbar"><input className="btn" style={{ flex: 1 }} placeholder="binding name, e.g. i or r" value={watchInput} onChange={(e) => setWatchInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && watchInput.trim()) { setWatches([...watches, watchInput.trim()]); setWatchInput(''); } }} aria-label="Add a watch" /></div>
          <table className="grid"><tbody>{watches.map((w, i) => <tr key={i}><td>{w}</td><td>{watchValue(w)}</td><td><button className="btn ghost" onClick={() => setWatches(watches.filter((_, k) => k !== i))} aria-label={`remove watch ${w}`}>×</button></td></tr>)}</tbody></table>
          <div className="subhead">Breakpoints · click the gutter left of the line numbers</div>
          <div className="check">{breakpoints.size ? [...breakpoints].sort((a, b) => a - b).map((l) => `line ${l}${session.breakableLines().includes(l) ? '' : ' (no code: never hit)'}`).join(' · ') : 'none (line breakpoints only; conditional breakpoints are not supported)'}</div>
          <div className="subhead">Scene so far</div>
          <div style={{ padding: 10 }}><SceneCanvas scene={scene} cmds={vm.scene.cmds} maxCss={420} label="Shapes drawn up to this step" /></div>
        </div>
      </div>
    </section>
  );
}
