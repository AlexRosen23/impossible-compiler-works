// The Possibility Chamber: canvas renderer for the reachable state graph.
// Everything drawn here comes from the checker's graph payload; nothing is invented.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CheckResult, GraphEdge, GraphNode, Trace } from '../types';
import { F_DEADLOCK, F_DOMAIN, F_FRONTIER, F_INITIAL, F_TERMINAL, F_VIOLATION } from '../types';

export type LayoutMode = 'layers' | 'witness' | 'scc';

interface Props {
  result: CheckResult;
  trace: Trace | null;
  selected: number | null;
  onSelect: (id: number) => void;
  mode: LayoutMode;
  reducedMotion: boolean;
  revealKey: string;
}

interface Pos { x: number; y: number; r: number; id: number; members?: number }

const C = {
  void: '#11101B', ink: '#20202E', line: '#34344A', porcelain: '#F0ECE4', indigo: '#9C9BDC', gold: '#C4A66E', mint: '#80B9A1', red: '#D07878', muted: '#8E8A9C',
};

function layoutLayers(nodes: GraphNode[], edges: GraphEdge[]): Map<number, Pos> {
  const byDepth = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth)!.push(n);
  }
  const parents = new Map<number, number[]>();
  for (const e of edges) {
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to)!.push(e.from);
  }
  const pos = new Map<number, Pos>();
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const colW = 110, rowH = 30;
  for (const d of depths) {
    const layer = byDepth.get(d)!;
    // barycentre ordering against the previous layer reduces edge crossings
    const bary = (n: GraphNode) => {
      const ps = (parents.get(n.id) ?? []).map((p) => pos.get(p)?.y).filter((y): y is number => y !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : n.id;
    };
    const sorted = d === 0 ? layer : [...layer].sort((a, b) => bary(a) - bary(b) || a.id - b.id);
    const h = (sorted.length - 1) * rowH;
    sorted.forEach((n, i) => pos.set(n.id, { x: d * colW, y: i * rowH - h / 2, r: 6, id: n.id }));
  }
  return pos;
}

function layoutWitness(nodes: GraphNode[], edges: GraphEdge[], trace: Trace | null): Map<number, Pos> {
  const pos = new Map<number, Pos>();
  if (!trace) return layoutLayers(nodes, edges);
  const path = trace.steps.map((s) => s.stateId).filter((id) => id >= 0);
  const onPath = new Set(path);
  const colW = 150;
  path.forEach((id, i) => { if (!pos.has(id)) pos.set(id, { x: i * colW, y: 0, r: 9, id }); });
  // alternative branches: successors of path states that leave the path
  path.forEach((id, i) => {
    const alts = edges.filter((e) => e.from === id && !onPath.has(e.to) && !pos.has(e.to)).map((e) => e.to);
    alts.forEach((t, k) => {
      const side = k % 2 === 0 ? -1 : 1;
      pos.set(t, { x: (i + 1) * colW - 40, y: side * (70 + Math.floor(k / 2) * 34), r: 5, id: t });
    });
  });
  return pos;
}

function layoutScc(nodes: GraphNode[]): Map<number, Pos> {
  const groups = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const k = n.scc >= 0 ? n.scc : -1 - n.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n);
  }
  const byDepth = new Map<number, { k: number; members: GraphNode[] }[]>();
  for (const [k, members] of groups) {
    const d = Math.min(...members.map((m) => m.depth));
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push({ k, members });
  }
  const pos = new Map<number, Pos>();
  for (const [d, list] of byDepth) {
    list.sort((a, b) => a.members[0].id - b.members[0].id);
    const h = (list.length - 1) * 44;
    list.forEach((g, i) => {
      const r = g.members.length > 1 ? 8 + Math.sqrt(g.members.length) * 3 : 5;
      // every member maps to the component's position (condensed view)
      for (const m of g.members) pos.set(m.id, { x: d * 120, y: i * 44 - h / 2, r, id: g.members[0].id, members: g.members.length });
    });
  }
  return pos;
}

export function Graph({ result, trace, selected, onSelect, mode, reducedMotion, revealKey }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [reveal, setReveal] = useState(1);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const nodes = result.graph?.nodes ?? [];
  const edges = result.graph?.edges ?? [];

  const pos = useMemo(() => (mode === 'witness' ? layoutWitness(nodes, edges, trace) : mode === 'scc' ? layoutScc(nodes) : layoutLayers(nodes, edges)), [nodes, edges, trace, mode]);
  const pathEdges = useMemo(() => {
    const s = new Set<string>();
    if (!trace) return s;
    const ids = trace.steps.map((x) => x.stateId);
    for (let i = 1; i < ids.length; i++) if (ids[i - 1] >= 0 && ids[i] >= 0) s.add(`${ids[i - 1]}>${ids[i]}`);
    return s;
  }, [trace]);
  const pathNodes = useMemo(() => new Set(trace?.steps.map((s) => s.stateId).filter((x) => x >= 0) ?? []), [trace]);
  const maxDepth = result.stats.maxDepth || 1;

  // fit to view whenever the layout changes
  useEffect(() => {
    const ps = [...pos.values()];
    if (!ps.length) return;
    const minX = Math.min(...ps.map((p) => p.x)), maxX = Math.max(...ps.map((p) => p.x));
    const minY = Math.min(...ps.map((p) => p.y)), maxY = Math.max(...ps.map((p) => p.y));
    const k = Math.min(2.2, (size.w - 80) / Math.max(1, maxX - minX), (size.h - 90) / Math.max(1, maxY - minY));
    setView({ k: Math.max(0.05, k), x: size.w / 2 - ((minX + maxX) / 2) * k, y: size.h / 2 - ((minY + maxY) / 2) * k - 10 });
  }, [pos, size.w, size.h]);

  // progressive reveal by logical step (layer) when a new result arrives
  useEffect(() => {
    if (reducedMotion) { setReveal(1); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      setReveal(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [revealKey, reducedMotion]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // draw
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size.w * dpr;
    cv.height = size.h * dpr;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const grd = g.createRadialGradient(size.w * 0.6, size.h * 0.1, 10, size.w * 0.5, size.h * 0.5, Math.max(size.w, size.h));
    grd.addColorStop(0, '#1c1a30');
    grd.addColorStop(1, C.void);
    g.fillStyle = grd;
    g.fillRect(0, 0, size.w, size.h);
    const T = (p: { x: number; y: number }) => ({ x: p.x * view.k + view.x, y: p.y * view.k + view.y });
    const visibleDepth = reveal * (maxDepth + 1);

    // cathedral columns: one per logical step
    if (mode !== 'witness') {
      const colW = mode === 'scc' ? 120 : 110;
      g.font = '10px ui-monospace, Menlo, monospace';
      for (let d = 0; d <= maxDepth; d++) {
        const x = d * colW * view.k + view.x;
        if (x < -20 || x > size.w + 20) continue;
        g.strokeStyle = 'rgba(156,155,220,0.06)';
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size.h); g.stroke();
        if (view.k * colW > 28 || d % 5 === 0) { g.fillStyle = 'rgba(240,236,228,0.28)'; g.fillText(`step ${d}`, x + 3, 14); }
      }
    }
    const nodeDepth = new Map(nodes.map((n) => [n.id, n.depth]));
    // edges
    g.lineWidth = 1;
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      if ((nodeDepth.get(e.to) ?? 0) > visibleDepth) continue;
      if (mode === 'scc' && a.id === b.id) continue;
      const onPath = pathEdges.has(`${e.from}>${e.to}`);
      if (onPath) continue;
      const pa = T(a), pb = T(b);
      g.strokeStyle = mode === 'witness' ? 'rgba(156,155,220,0.22)' : 'rgba(156,155,220,0.16)';
      g.beginPath();
      if (e.from === e.to) { g.arc(pa.x, pa.y - 10, 8, 0, Math.PI * 2); }
      else {
        const mx = (pa.x + pb.x) / 2;
        g.moveTo(pa.x, pa.y);
        g.bezierCurveTo(mx, pa.y, mx, pb.y, pb.x, pb.y);
      }
      g.stroke();
    }
    // the witness thread: gold with glow
    if (trace) {
      const ids = trace.steps.map((s) => s.stateId);
      g.save();
      g.lineWidth = 2.6;
      g.strokeStyle = C.gold;
      if (!reducedMotion) { g.shadowColor = 'rgba(196,166,110,0.9)'; g.shadowBlur = 14; }
      for (let i = 1; i < ids.length; i++) {
        const a = pos.get(ids[i - 1]), b = pos.get(ids[i]);
        if (!a || !b) continue;
        if ((nodeDepth.get(ids[i]) ?? 0) > visibleDepth) continue;
        const pa = T(a), pb = T(b);
        const isLoopBack = trace.loopStart !== undefined && i === ids.length - 1;
        g.setLineDash(isLoopBack ? [6, 5] : []);
        g.strokeStyle = isLoopBack ? C.indigo : C.gold;
        g.beginPath();
        if (ids[i] === ids[i - 1]) g.arc(pa.x, pa.y - 14, 11, 0, Math.PI * 2);
        else if (isLoopBack) {
          g.moveTo(pa.x, pa.y);
          const lift = 60 + Math.abs(pa.x - pb.x) * 0.15;
          g.bezierCurveTo(pa.x, pa.y - lift, pb.x, pb.y - lift, pb.x, pb.y);
        } else {
          const mx = (pa.x + pb.x) / 2;
          g.moveTo(pa.x, pa.y);
          g.bezierCurveTo(mx, pa.y, mx, pb.y, pb.x, pb.y);
        }
        g.stroke();
      }
      g.restore();
    }
    // nodes
    const drawn = new Set<number>();
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      if (n.depth > visibleDepth) continue;
      if (mode === 'scc' && drawn.has(p.id)) continue;
      drawn.add(p.id);
      const q = T(p);
      if (q.x < -30 || q.y < -30 || q.x > size.w + 30 || q.y > size.h + 30) continue;
      const r = Math.max(2.2, Math.min(p.r * Math.sqrt(view.k), p.r * 1.6));
      const f = n.flags;
      const onPath = pathNodes.has(n.id);
      g.save();
      if (onPath && !reducedMotion) { g.shadowColor = 'rgba(196,166,110,0.8)'; g.shadowBlur = 12; }
      g.beginPath();
      g.arc(q.x, q.y, r, 0, Math.PI * 2);
      let fill = 'rgba(240,236,228,0.55)';
      if (f & F_TERMINAL) fill = C.mint;
      if (onPath) fill = C.gold;
      if (f & (F_VIOLATION | F_DOMAIN)) fill = C.red;
      if (f & F_DEADLOCK) fill = C.ink;
      if (f & F_FRONTIER) fill = 'rgba(17,16,27,0.9)';
      if (mode === 'scc' && (p.members ?? 1) > 1) fill = 'rgba(156,155,220,0.55)';
      g.fillStyle = fill;
      g.fill();
      g.restore();
      if (f & F_DEADLOCK) { g.strokeStyle = C.red; g.lineWidth = 2.2; g.stroke(); }
      if (f & F_FRONTIER) { g.setLineDash([3, 3]); g.strokeStyle = C.gold; g.lineWidth = 1.4; g.stroke(); g.setLineDash([]); }
      if (f & F_INITIAL) { g.beginPath(); g.arc(q.x, q.y, r + 3.5, 0, Math.PI * 2); g.strokeStyle = C.indigo; g.lineWidth = 1.4; g.stroke(); }
      if (n.id === selected || (mode === 'scc' && selected !== null && pos.get(selected)?.id === p.id)) {
        g.beginPath(); g.arc(q.x, q.y, r + 7, 0, Math.PI * 2); g.strokeStyle = C.porcelain; g.lineWidth = 1.6; g.stroke();
      }
      if (view.k > 1.1 || mode === 'witness') {
        g.fillStyle = 'rgba(240,236,228,0.6)';
        g.font = '10px ui-monospace, Menlo, monospace';
        g.fillText(mode === 'scc' && (p.members ?? 1) > 1 ? `SCC ×${p.members}` : `s${n.id}`, q.x + r + 4, q.y + 3);
      }
    }
    if (result.graph?.truncated) {
      g.fillStyle = C.gold;
      g.font = '12px system-ui';
      g.fillText(`Showing the first ${nodes.length} of ${result.stats.states} states (render cap); counts and verdicts cover all states.`, 14, size.h - 14);
    }
  }, [pos, view, size, nodes, edges, pathEdges, pathNodes, selected, trace, reveal, mode, maxDepth, reducedMotion, result.graph?.truncated, result.stats.states]);

  const pick = (cx: number, cy: number): number | null => {
    let best: number | null = null;
    let bd = 14 * 14;
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const x = p.x * view.k + view.x - cx, y = p.y * view.k + view.y - cy;
      const d = x * x + y * y;
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (selected === null) { if (nodes.length) onSelect(0); return; }
    const cur = nodes.find((n) => n.id === selected);
    if (!cur) return;
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = edges.find((x) => x.from === selected && x.to !== selected)?.to;
    else if (e.key === 'ArrowLeft') next = edges.find((x) => x.to === selected && (nodes[x.from]?.depth ?? 0) < cur.depth)?.from;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const layer = nodes.filter((n) => n.depth === cur.depth).sort((a, b) => (pos.get(a.id)?.y ?? 0) - (pos.get(b.id)?.y ?? 0));
      const i = layer.findIndex((n) => n.id === selected);
      next = layer[i + (e.key === 'ArrowDown' ? 1 : -1)]?.id;
    } else if (e.key === 'Home') next = 0;
    else return;
    e.preventDefault();
    if (next !== undefined) onSelect(next);
  };

  const legend = [
    ['initial', C.indigo, true], ['witness path', C.gold, false], ['violates', C.red, false], ['deadlock', C.red, true], ['terminal', C.mint, false], ['unexplored (cap)', C.gold, true],
  ] as const;

  return (
    <div ref={wrap} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <canvas
        ref={canvas}
        tabIndex={0}
        role="img"
        aria-label={`State graph: ${result.stats.states} reachable states, ${result.stats.edges} transitions, ${result.stats.maxDepth} logical steps deep. ${trace ? `Witness for ${trace.property} highlighted, ${trace.length} steps.` : ''} Use arrow keys to move between states; the States tab lists the same states as a table.`}
        data-testid="state-graph"
        style={{ width: '100%', height: '100%' }}
        onKeyDown={onKey}
        onWheel={(e) => {
          const rect = canvas.current!.getBoundingClientRect();
          const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
          const f = Math.exp(-e.deltaY * 0.0015);
          setView((v) => { const k = Math.min(8, Math.max(0.03, v.k * f)); return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) }; });
        }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
          if (d.moved) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const rect = canvas.current!.getBoundingClientRect();
            const id = pick(e.clientX - rect.left, e.clientY - rect.top);
            if (id !== null) onSelect(id);
          }
        }}
      />
      <div className="overlay">
        <div className="legend" aria-hidden="true">
          {legend.map(([label, color, ring]) => (
            <span key={label}><i style={ring ? { border: `2px solid ${color}`, background: 'transparent', width: 8, height: 8 } : { background: color }} />{label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
