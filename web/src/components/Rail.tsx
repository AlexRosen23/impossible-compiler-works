// Precision rail: the selected state's logical step, typed variables, enabled actions,
// parents and the property picture at that point.
import type { CheckResult, Value } from '../types';
import { F_DEADLOCK, F_DOMAIN, F_FRONTIER, F_INITIAL, F_TERMINAL } from '../types';

interface Props {
  result: CheckResult;
  selected: number | null;
  onSelect: (id: number) => void;
}

export function flagText(f: number, viol?: string[]): string[] {
  const out: string[] = [];
  if (f & F_INITIAL) out.push('initial');
  if (viol?.length) out.push(`violates ${viol.join(', ')}`);
  if (f & F_DEADLOCK) out.push('DEADLOCK');
  if (f & F_TERMINAL) out.push('intended terminal');
  if (f & F_FRONTIER) out.push('unexplored (cap)');
  if (f & F_DOMAIN) out.push('next step leaves a domain');
  return out;
}

export const show = (v: Value | undefined) => (v === undefined ? '—' : String(v));

export function Rail({ result, selected, onSelect }: Props) {
  if (selected === null || !result.states || !result.graph) {
    return <div className="empty" style={{ fontSize: 14 }}>Select a state in the graph (click, or focus the graph and use the arrow keys).</div>;
  }
  const node = result.graph.nodes[selected];
  const st = result.states[selected];
  if (!node || !st) return <div className="empty">State outside the rendered range.</div>;
  const out = result.graph.edges.filter((e) => e.from === selected);
  const inc = result.graph.edges.filter((e) => e.to === selected && e.from !== selected);
  const bfsParent = inc.find((e) => result.graph!.nodes[e.from]?.depth === node.depth - 1);
  const parentState = bfsParent ? result.states[bfsParent.from] : null;
  const procs = ['', ...result.model.processes];
  const enabled = new Set(out.map((e) => e.action));
  return (
    <div data-testid="state-rail">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="verdict" style={{ fontSize: 20 }}>state s{selected}</span>
        <span className="pill" title="logical steps from an initial state along a shortest path">step {node.depth}</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        {flagText(node.flags, node.viol).map((f) => <span key={f} className={`pill ${/violates|DEADLOCK|domain/.test(f) ? 'bad' : /terminal/.test(f) ? 'ok' : 'warn'}`}>{f}</span>)}
        <span className="pill mono" title="first 12 hex digits of the canonical state digest">#{node.key}</span>
      </div>
      {procs.map((p) => {
        const vars = result.model.vars.filter((v) => (v.process ?? '') === p);
        if (!vars.length) return null;
        return (
          <div key={p || 'globals'}>
            <div className="section-title">{p ? `process ${p}` : 'shared variables'}</div>
            <table className="vars"><tbody>
              {vars.map((v) => {
                const changed = parentState && parentState[v.name] !== st[v.name];
                return (
                  <tr key={v.name} className={changed ? 'changed' : ''}>
                    <td title={`type ${v.type}`}>{p ? v.name.slice(p.length + 1) : v.name}</td>
                    <td>{changed ? <><span style={{ color: 'var(--muted)' }}>{show(parentState![v.name])} → </span>{show(st[v.name])}</> : show(st[v.name])}</td>
                  </tr>
                );
              })}
            </tbody></table>
          </div>
        );
      })}
      <div className="section-title">enabled actions ({out.length})</div>
      {out.length === 0 ? <p style={{ color: node.flags & F_DEADLOCK ? 'var(--vermilion)' : 'var(--muted)', margin: 0, fontSize: 12.5 }}>{node.flags & F_DEADLOCK ? 'No action is enabled and this is not a declared terminal state: deadlock.' : node.flags & F_FRONTIER ? 'Not expanded: the exploration cap was reached first.' : 'None (intended terminal state).'}</p> : (
        <ul className="list">
          {out.map((e, i) => {
            const a = result.model.actions[e.action];
            return <li key={i}><button onClick={() => onSelect(e.to)} title={`guard: ${a.guard}`}><span className="act">{a.label}</span> <span style={{ color: 'var(--muted)' }}>→ s{e.to}{e.to === selected ? ' (self-loop)' : ''}</span></button></li>;
          })}
        </ul>
      )}
      <div className="section-title">disabled here</div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{result.model.actions.filter((_, i) => !enabled.has(i)).map((a) => a.label).join(', ') || '—'}</p>
      <div className="section-title">reached from ({inc.length})</div>
      <ul className="list">
        {inc.slice(0, 12).map((e, i) => <li key={i}><button onClick={() => onSelect(e.from)}><span style={{ color: 'var(--muted)' }}>s{e.from} —</span> <span className="act">{result.model.actions[e.action].label}</span>{bfsParent === e ? <span className="pill" style={{ marginLeft: 6 }}>shortest</span> : null}</button></li>)}
      </ul>
    </div>
  );
}
