import { useEffect, useState } from 'react';
import type { StageRecord } from '../../../core/index.ts';
import { SceneCanvas } from '../SceneCanvas.tsx';
import { type Mode, runFrame, useWB } from '../workbench.ts';

const STAGE_MODE: Record<string, Mode> = { 'lex+parse': 'furnace', check: 'observatory', fixtures: 'observatory', lower: 'lowering', optimize: 'duel', codegen: 'lowering', verify: 'lowering' };
const ALL = ['lex+parse', 'check', 'fixtures', 'lower', 'optimize', 'codegen', 'verify'];

export function PipelineRail() {
  const { compiled, setMode } = useWB();
  const [gen, setGen] = useState(0);
  useEffect(() => setGen((g) => g + 1), [compiled.sourceHash, compiled.passes]);
  const recs = new Map<string, StageRecord>(compiled.stages.map((s) => [s.stage, s]));
  return (
    <div className="rail" key={gen} aria-label="Compiler pipeline">
      {ALL.map((name, i) => {
        const s = recs.get(name);
        return (
          <div key={name}>
            {i > 0 && <div className="connector" aria-hidden="true" />}
            <button className={`stage ${!s ? 'skip' : s.ok ? 'lit' : 'fail'}`} style={{ animationDelay: `${i * 70}ms` }} onClick={() => setMode(STAGE_MODE[name])} title={s ? `input ${s.inputHash}\noutput ${s.outputHash ?? '—'}` : 'not reached'}>
              <span className="idx">{String(i + 1).padStart(2, '0')}</span>
              <span className="name">{name}</span>
              <span className="ms">{s ? `${s.ms.toFixed(2)} ms` : '—'}</span>
              <span className="sum">{s ? s.summary : 'not reached (an earlier stage failed)'}</span>
              {s?.outputHash && <span className="hash">⟶ {s.outputHash.slice(0, 16)}</span>}
            </button>
          </div>
        );
      })}
      <div className="connector" aria-hidden="true" />
      <button className={`stage ${compiled.ok ? 'lit' : 'skip'}`} style={{ animationDelay: '520ms' }} onClick={() => setMode('theater')}>
        <span className="idx">08</span><span className="name">vm + reference</span><span className="ms" />
        <span className="sum">{compiled.ok ? 'executed per frame; checked against the AST interpreter' : 'not reached'}</span>
      </button>
    </div>
  );
}

export function ScenePane({ title = 'Rendered scene' }: { title?: string }) {
  const { compiled, frame, setFrame, select } = useWB();
  const [playing, setPlaying] = useState(false);
  const frames = compiled.check?.scene?.frames ?? 1;
  const f = Math.min(frame, frames - 1);
  const run = compiled.ok ? runFrame(compiled, f) : null;
  useEffect(() => {
    if (!playing || frames < 2) return;
    const id = setInterval(() => setFrame((f + 1) % frames), 1000 / 24);
    return () => clearInterval(id);
  }, [playing, f, frames, setFrame]);
  const scene = compiled.ok && compiled.check?.scene ? { format: 'folio-scene/0.1', ...compiled.check.scene, frames: [] } : null;
  return (
    <section className="pane" aria-label={title}>
      <div className="pane-head"><h2>{title}</h2><span>{scene ? `${scene.width}×${scene.height} · ${frames} frame${frames > 1 ? 's' : ''}` : ''}</span></div>
      <div className="scene-stage"><SceneCanvas scene={scene} cmds={run?.cmds ?? null} /></div>
      {frames > 1 && (
        <div className="transport">
          <button className="btn" onClick={() => setPlaying(!playing)} aria-pressed={playing}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <input type="range" min={0} max={frames - 1} value={f} onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)); }} aria-label="Frame" />
          <span className="t">frame {f} · time {(f / frames).toFixed(4)}</span>
        </div>
      )}
      <div className="verdict" aria-live="polite">
        {run ? <>
          <span>{run.cmds.length} shapes · {run.steps.toLocaleString()} VM steps · {run.ms.toFixed(2)} ms</span>
          {run.resourceLimit ? <span>The {run.resourceWho} stopped at its own work limit ({run.resourceWho === 'VM' ? run.fault?.code : 'R014'}); the other executor does not share it, so no verdict</span>
            : <span className={run.agree ? 'agree' : 'disagree'}>{run.agree ? '✓ VM ≡ reference interpreter (this frame)' : '✗ VM and reference DIVERGE'}</span>}
          <span title={`VM ${run.vmHash}\nreference ${run.refHash}`}>frame hash {run.vmHash.slice(0, 12)}</span>
          {run.fault && <button className="btn" onClick={() => run.fault?.span && select(run.fault.span)}>{run.fault.code} at {run.fault.span?.line}:{run.fault.span?.col} — {run.fault.message}</button>}
        </> : <span>{compiled.ok ? '' : 'Fix the diagnostics to run the program.'}</span>}
      </div>
    </section>
  );
}

export function Editorial() {
  return (
    <>
      <section className="pane rail-pane" aria-label="Pipeline">
        <div className="pane-head"><h2>Compiler pipeline</h2><span>click a stage to inspect it</span></div>
        <div className="pane-body"><PipelineRail /></div>
      </section>
      <ScenePane />
    </>
  );
}
