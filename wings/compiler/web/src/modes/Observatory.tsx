import { useMemo, useState } from 'react';
import { useWB } from '../workbench.ts';

export function Observatory() {
  const { compiled, select, source } = useWB();
  const [filter, setFilter] = useState('');
  const c = compiled.check;
  const trace = useMemo(() => (c ? c.trace.map((t) => ({ ...t, text: source.slice(t.span.start, t.span.end).replace(/\s+/g, ' ') })) : []), [c, source]);
  if (!c) return <section className="pane"><div className="pane-head"><h2>C · The Type Observatory</h2></div><div className="empty">The checker has not run: the program does not parse yet. Parsing and type checking are separate stages.</div></section>;
  const shown = trace.filter((t) => !filter || t.text.includes(filter) || t.type.includes(filter) || t.rule.includes(filter)).slice(0, 400);
  const scopesById = new Map(c.scopes.map((s) => [s.id, s]));
  const depth = (id: number): number => { let d = 0; for (let s = scopesById.get(id); s && s.parent !== null; s = scopesById.get(s.parent)) d++; return d; };
  const checkStage = compiled.stages.find((s) => s.stage === 'check');
  return (
    <section className="pane" aria-label="Type Observatory">
      <div className="pane-head"><h2>C · The Type Observatory</h2><span>scopes · symbols · how every expression got its type</span></div>
      <div className="stats">
        <div className="stat"><b>{c.scopes.length}</b><span>scopes</span></div>
        <div className="stat"><b>{c.symbols.length}</b><span>symbols</span></div>
        <div className="stat"><b>{c.types.size}</b><span>typed expressions</span></div>
        <div className="stat"><b>{c.diagnostics.filter((d) => d.severity === 'error').length}</b><span>type errors</span></div>
        <div className="stat"><b>{c.diagnostics.filter((d) => d.severity === 'warning').length}</b><span>warnings</span></div>
        <div className="stat"><b>{checkStage?.ok ? 'pass' : 'fail'}</b><span>check stage</span></div>
      </div>
      <div className="cols" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane-body">
          <div className="subhead">Scope graph and symbol table</div>
          <table className="grid"><thead><tr><th>Scope / name</th><th>Kind</th><th>Type</th><th>Decl</th><th>Uses</th></tr></thead><tbody>
            {c.scopes.map((s) => [
              <tr key={`s${s.id}`}><td colSpan={5} style={{ paddingLeft: 10 + depth(s.id) * 14, color: 'var(--brass)' }}>{s.kind === 'global' ? '◆' : '▸'} {s.label} <span style={{ color: 'var(--muted)' }}>#{s.id}{s.parent !== null ? ` ⊂ #${s.parent}` : ''}</span></td></tr>,
              ...s.symbols.map((id) => c.symbols[id]).filter((sym) => sym.declNode >= 0).map((sym) => (
                <tr key={`y${sym.id}`} className="click" onClick={() => select(sym.declSpan)}>
                  <td style={{ paddingLeft: 24 + depth(s.id) * 14 }}>{sym.name}</td><td>{sym.kind}</td><td style={{ color: 'var(--chalk)' }}>{sym.type}</td><td>{sym.declSpan.line}:{sym.declSpan.col}</td><td>{sym.uses.length}</td>
                </tr>
              )),
            ])}
          </tbody></table>
          <div className="subhead">Functions and call graph (recursion is rejected statically)</div>
          <table className="grid"><thead><tr><th>Function</th><th>Signature</th><th>Calls</th></tr></thead><tbody>
            {[...c.fns.values()].map((f) => <tr key={f.name}><td>{f.name}</td><td style={{ color: 'var(--chalk)' }}>({f.params.map((p, i) => `${f.paramNames[i]}: ${p}`).join(', ')}) → {f.ret}</td><td>{(c.callGraph[f.name] ?? []).join(', ') || '—'}</td></tr>)}
            {c.fns.size === 0 && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>no user functions</td></tr>}
          </tbody></table>
          {c.data.length > 0 && <><div className="subhead">Datasets (read-only fixtures)</div><table className="grid"><tbody>{c.data.map((d) => <tr key={d.name}><td>{d.name}</td><td style={{ color: 'var(--chalk)' }}>{d.type}</td><td>fixture "{d.fixture}" · {compiled.data.has(d.name) ? `${(compiled.data.get(d.name) as unknown[]).length} items bound` : 'not bound'}</td></tr>)}</tbody></table></>}
        </div>
        <div className="pane-body">
          <div className="subhead">Type derivation trace</div>
          <div className="toolbar"><input className="btn" style={{ flex: 1 }} placeholder="filter by text, type or rule" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter the type trace" /><span className="badge">{shown.length} of {trace.length}</span></div>
          <table className="grid"><thead><tr><th>Expression</th><th>Type</th><th>Rule</th></tr></thead><tbody>
            {shown.map((t, i) => (
              <tr key={i} className="click" onClick={() => select(t.span)}>
                <td title={`${t.span.line}:${t.span.col}`}>{t.text.length > 34 ? t.text.slice(0, 32) + '…' : t.text}</td>
                <td style={{ color: t.type === 'Error' ? 'var(--oxblood)' : 'var(--chalk)' }}>{t.type}</td><td style={{ color: 'var(--cream-dim)' }}>{t.rule}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </section>
  );
}
