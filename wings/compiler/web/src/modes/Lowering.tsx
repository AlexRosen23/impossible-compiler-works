import { useState } from 'react';
import { type BasicBlock, type IRFunction, type IRModule, disassemble, showInstr, showTerm, successors } from '../../../core/index.ts';
import { useWB } from '../workbench.ts';

export function IRListing({ f, mark }: { f: IRFunction; mark?: (id: number) => 'gone' | 'new' | null }) {
  const { select } = useWB();
  return (
    <div>
      {f.blocks.map((b) => (
        <div className="ir-block" key={b.id}>
          <div className="bl">{b.label}:</div>
          {b.instrs.map((i) => (
            <div key={i.id} className={`ir-line ${mark?.(i.id) ?? ''}`} onClick={() => select(i.span)} title={`type ${i.type ?? 'void'}`}>
              <span className="iid">#{i.id}</span><span>{showInstr(i, f)}</span><span className="ln">{i.span.line}:{i.span.col}</span>
            </div>
          ))}
          <div className="ir-line term" onClick={() => select(b.term.span)}><span className="iid" /><span>{showTerm(b.term, f.blocks)}</span><span className="ln" /></div>
        </div>
      ))}
    </div>
  );
}

/** Layered control-flow graph: layers by DFS order ignoring back edges; back edges are drawn as arcs. */
export function CFG({ f, reachable }: { f: IRFunction; reachable?: Set<number> }) {
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const order: number[] = [];
  const state = new Map<number, number>();
  const back = new Set<string>();
  const visit = (id: number) => { state.set(id, 1); for (const s of successors(byId.get(id)!.term)) { if (state.get(s) === 1) back.add(`${id}>${s}`); else if (!state.has(s) && byId.has(s)) visit(s); } state.set(id, 2); order.push(id); };
  visit(f.blocks[0].id);
  for (const b of f.blocks) if (!state.has(b.id)) visit(b.id);
  order.reverse();
  const layer = new Map<number, number>();
  for (const id of order) {
    let l = 0;
    for (const b of f.blocks) for (const s of successors(b.term)) if (s === id && !back.has(`${b.id}>${id}`) && layer.has(b.id)) l = Math.max(l, layer.get(b.id)! + 1);
    layer.set(id, l);
  }
  const layers: number[][] = [];
  for (const id of order) (layers[layer.get(id)!] ??= []).push(id);
  const W = 150, H = 40, GX = 26, GY = 34;
  const width = Math.max(...layers.map((l) => l.length)) * (W + GX) + 80;
  const pos = new Map<number, { x: number; y: number }>();
  layers.forEach((l, li) => l.forEach((id, k) => pos.set(id, { x: 20 + k * (W + GX) + (width - 80 - l.length * (W + GX)) / 2, y: 16 + li * (H + GY) })));
  const height = layers.length * (H + GY) + 20;
  const edges: { from: BasicBlock; to: number; kind: string }[] = [];
  for (const b of f.blocks) {
    const t = b.term;
    if (t.op === 'jmp') edges.push({ from: b, to: t.target, kind: 'jmp' });
    if (t.op === 'br') { edges.push({ from: b, to: t.t, kind: 'true' }); edges.push({ from: b, to: t.f, kind: 'false' }); }
  }
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Control-flow graph of ${f.name}: ${f.blocks.length} blocks, ${edges.length} edges, ${back.size} back edges (loops)`}>
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8e8a82" /></marker></defs>
      {edges.map((e, i) => {
        const a = pos.get(e.from.id)!, b = pos.get(e.to);
        if (!b) return null;
        const isBack = back.has(`${e.from.id}>${e.to}`);
        const color = e.kind === 'true' ? '#8db7a2' : e.kind === 'false' ? '#b2534f' : '#8e8a82';
        if (isBack) {
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x + W, y2 = b.y + H / 2;
          return <path key={i} d={`M${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 + 60} ${y2}, ${x2} ${y2}`} fill="none" stroke={color} strokeDasharray="4 3" markerEnd="url(#ah)" />;
        }
        return <line key={i} x1={a.x + W / 2} y1={a.y + H} x2={b.x + W / 2} y2={b.y} stroke={color} markerEnd="url(#ah)" />;
      })}
      {f.blocks.map((b) => {
        const p = pos.get(b.id)!;
        const dead = reachable && !reachable.has(b.id);
        return (
          <g key={b.id}>
            <rect x={p.x} y={p.y} width={W} height={H} rx={3} fill={dead ? '#1d1414' : '#18181c'} stroke={dead ? '#6a3432' : b.id === f.blocks[0].id ? '#bb9c67' : '#34353c'} strokeDasharray={dead ? '4 3' : undefined} />
            <text x={p.x + 8} y={p.y + 16} fill="#f0eadd" fontFamily="SF Mono, Menlo, monospace" fontSize="11">{b.label}</text>
            <text x={p.x + 8} y={p.y + 31} fill="#8e8a82" fontFamily="SF Mono, Menlo, monospace" fontSize="10">{b.instrs.length} instr · {b.term.op}{dead ? ' · unreachable' : ''}</text>
          </g>
        );
      })}
    </svg>
  );
}

function reach(f: IRFunction): Set<number> {
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const seen = new Set<number>(); const st = [f.blocks[0].id];
  while (st.length) { const id = st.pop()!; if (seen.has(id) || !byId.has(id)) continue; seen.add(id); st.push(...successors(byId.get(id)!.term)); }
  return seen;
}

export function Lowering() {
  const { compiled, select } = useWB();
  const [which, setWhich] = useState<'lowered' | 'optimized'>('optimized');
  const [fi, setFi] = useState(-1);
  if (!compiled.ir) return <section className="pane"><div className="pane-head"><h2>D · The Lowering Floor</h2></div><div className="empty">Lowering runs after a successful check.</div></section>;
  const m: IRModule = which === 'optimized' && compiled.irOptimized ? compiled.irOptimized : compiled.ir;
  const idx = fi < 0 || fi >= m.functions.length ? m.main : fi;
  const f = m.functions[idx];
  const bc = compiled.bytecode;
  const dis = bc ? disassemble(bc, idx) : [];
  const verify = compiled.stages.find((s) => s.stage === 'verify');
  return (
    <section className="pane" aria-label="Lowering Floor">
      <div className="pane-head"><h2>D · The Lowering Floor</h2><span>typed AST → IR → control flow → bytecode</span></div>
      <div className="toolbar">
        {m.functions.map((g, i) => <button key={g.name} className={`btn ${i === idx ? 'primary' : ''}`} onClick={() => setFi(i)}>{g.name === 'scene' ? 'scene' : `fn ${g.name}`}</button>)}
        <span style={{ flex: 1 }} />
        <label className="toggle"><input type="radio" checked={which === 'lowered'} onChange={() => setWhich('lowered')} />as lowered</label>
        <label className="toggle"><input type="radio" checked={which === 'optimized'} onChange={() => setWhich('optimized')} />after passes [{compiled.passes.join(', ') || 'none'}]</label>
      </div>
      <div className="stats">
        <div className="stat"><b>{f.blocks.length}</b><span>blocks</span></div>
        <div className="stat"><b>{f.blocks.reduce((n, b) => n + b.instrs.length, 0)}</b><span>instructions</span></div>
        <div className="stat"><b>{f.nregs}</b><span>registers</span></div>
        <div className="stat"><b>{f.slots.length}</b><span>slots</span></div>
        <div className="stat"><b>{dis.length}</b><span>bytecode ops</span></div>
        <div className="stat"><b>{bc ? bc.hash.slice(0, 10) : '—'}</b><span>bytecode sha256</span></div>
        <div className="stat"><b>{verify?.ok ? 'verified' : '—'}</b><span>stack · jumps · operands</span></div>
      </div>
      <div className="cols" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane-body">
          <div className="subhead">IR · {m.version} · registers are single-assignment; slots hold mutable state</div>
          <IRListing f={f} />
          <div className="subhead">Control-flow graph · green = true edge, red = false edge, dashed = loop back edge</div>
          <div className="cfg" style={{ padding: '0 10px 16px' }}><CFG f={f} reachable={reach(f)} /></div>
        </div>
        <div className="pane-body">
          <div className="subhead">Bytecode · {bc?.version ?? ''} · {f.slots.map((s, i) => `$${i} ${s.name}`).join('  ')}</div>
          {bc ? (
            <table className="grid"><thead><tr><th>pc</th><th>instruction</th><th>stack</th><th>line</th><th>ir</th></tr></thead><tbody>
              {dis.map((d) => <tr key={d.pc} className="click" onClick={() => { const s = bc.functions[idx].spans[d.pc]; select({ start: s[0], end: s[1], line: s[2], col: s[3] }); }}><td>{d.pc}</td><td>{d.text}</td><td style={{ color: 'var(--muted)' }}>{d.effect}</td><td>{d.line}</td><td style={{ color: 'var(--muted)' }}>{d.ir >= 0 ? `#${d.ir}` : ''}</td></tr>)}
            </tbody></table>
          ) : <div className="empty">No bytecode (an earlier stage failed).</div>}
          {bc && <><div className="subhead">Constant pool ({bc.consts.length})</div><pre className="block">{bc.consts.map((c, i) => `${String(i).padStart(3)}  ${JSON.stringify(c)}`).join('\n')}</pre></>}
        </div>
      </div>
    </section>
  );
}
