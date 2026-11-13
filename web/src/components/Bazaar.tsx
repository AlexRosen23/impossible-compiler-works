// The Model Bazaar: executable examples organised by systems concept.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ModelRow, Scenario } from '../types';

function HeroArt() {
  // Decorative only: an abstract branching lattice with one thread. It shows no verdict.
  const cols = 7;
  const nodes: { x: number; y: number; c: number }[] = [];
  for (let c = 0; c < cols; c++) {
    const n = c === 0 ? 1 : Math.min(2 + c, 6);
    for (let k = 0; k < n; k++) nodes.push({ x: 40 + c * 80, y: 160 + (k - (n - 1) / 2) * 42, c });
  }
  const thread = [0, 2, 5, 10, 16, 22, 27].map((i) => nodes[Math.min(i, nodes.length - 1)]);
  return (
    <svg viewBox="0 0 560 320" className="hero-art" role="img" aria-label="Decorative illustration: branching possible futures with one highlighted thread">
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <radialGradient id="bg" cx="70%" cy="10%" r="90%"><stop offset="0" stopColor="#1d1b33" /><stop offset="1" stopColor="#11101B" /></radialGradient>
      </defs>
      <rect width="560" height="320" fill="url(#bg)" />
      {Array.from({ length: cols }, (_, c) => <line key={c} x1={40 + c * 80} x2={40 + c * 80} y1="20" y2="300" stroke="rgba(156,155,220,0.07)" />)}
      {nodes.map((a, i) => nodes.filter((b) => b.c === a.c + 1 && Math.abs(b.y - a.y) < 95).map((b, j) => (
        <path key={`${i}-${j}`} d={`M${a.x},${a.y} C${a.x + 40},${a.y} ${b.x - 40},${b.y} ${b.x},${b.y}`} fill="none" stroke="rgba(156,155,220,0.22)" />
      )))}
      <path d={thread.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `C${thread[i - 1].x + 40},${thread[i - 1].y} ${p.x - 40},${p.y} ${p.x},${p.y}`)).join(' ')} fill="none" stroke="#C4A66E" strokeWidth="2.5" filter="url(#glow)" />
      {nodes.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={thread.includes(p) ? 6 : 4} fill={thread.includes(p) ? '#C4A66E' : 'rgba(240,236,228,0.5)'} />)}
      <circle cx={thread[thread.length - 1].x} cy={thread[thread.length - 1].y} r="9" fill="none" stroke="#D07878" strokeWidth="2" />
    </svg>
  );
}

export function Bazaar() {
  const [scen, setScen] = useState<Scenario[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [concept, setConcept] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    void api.catalog().then((c) => setScen(c.scenarios.sort((a, b) => a.order - b.order))).catch((e) => setErr(String(e.message)));
    void api.models().then((m) => setModels(m.models)).catch(() => {});
  }, []);
  const concepts = useMemo(() => [...new Set(scen.flatMap((s) => s.concepts))].sort(), [scen]);
  const users = models.filter((m) => m.origin === 'user');
  const shown = scen.filter((s) => !concept || s.concepts.includes(concept));
  return (
    <main className="bazaar" id="main">
      <section className="hero">
        <div>
          <h1>Can this system ever reach a state that should be <em>impossible</em>?</h1>
          <p>The Witness wing explores every reachable state of a small, finite model of a concurrent system. When something bad is reachable it returns the <b>shortest schedule</b> that gets there — a witness you can step through, replay independently, cross-check with TLC and seal in a tamper-evident receipt.</p>
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>Every verdict is about the declared finite model and its assumptions — never a proof about production software.</p>
          <div className="row" style={{ marginTop: 14 }}>
            <a className="btn primary" href="#/journey" data-testid="start-journey">Start the 90-second journey</a>
            <a className="btn" href="#/model/counter-race">Novice: two threads, one counter</a>
            <a className="btn ghost" href="#/new">Write a model</a>
          </div>
        </div>
        <HeroArt />
      </section>
      {err && <p className="callout red">Cannot reach the checker service: {err}. Start it with <code>scripts/dev</code>.</p>}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontFamily: 'var(--serif)', fontWeight: 400, margin: 0 }}>The Model Bazaar <span style={{ color: 'var(--muted)', fontSize: 15 }}>· {scen.length} scenarios, {models.filter((m) => m.origin === 'example').length} executable models</span></h2>
        <div className="chips" role="group" aria-label="Filter by concept">
          <button className={`chip ${concept === null ? 'on' : ''}`} onClick={() => setConcept(null)} aria-pressed={concept === null}>all</button>
          {concepts.map((c) => <button key={c} className={`chip ${concept === c ? 'on' : ''}`} onClick={() => setConcept(c)} aria-pressed={concept === c}>{c}</button>)}
        </div>
      </div>
      <div className="cards" data-testid="scenario-cards">
        {shown.map((s) => (
          <article className="card" key={s.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="num">{String(s.order).padStart(2, '0')} · {s.level}</span><div className="chips">{s.concepts.map((c) => <span key={c} className="chip">{c}</span>)}</div></div>
            <h3>{s.title}</h3>
            <p>{s.lesson}</p>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>{s.try}</p>
            <div className="actions">
              {s.broken === s.fixed ? <a className="btn small" href={`#/model/${s.broken}`}>Open model</a> : <>
                <a className="btn small" href={`#/model/${s.broken}`}>Open the flawed model</a>
                <a className="btn small ghost" href={`#/model/${s.fixed}`}>Open the repair</a>
              </>}
              {s.extra?.map((x) => <a key={x} className="btn small ghost" href={`#/model/${x}`}>{x}</a>)}
            </div>
          </article>
        ))}
      </div>
      {users.length > 0 && (
        <>
          <h2 style={{ fontFamily: 'var(--serif)', fontWeight: 400 }}>Your models</h2>
          <div className="cards">{users.map((m) => <article key={m.id} className="card"><h3>{m.title}</h3><p className="num">{m.slug} · {m.revisions} revision(s)</p><div className="actions"><a className="btn small" href={`#/model/${m.slug}`}>Open</a></div></article>)}</div>
        </>
      )}
    </main>
  );
}

const STARTER = `model my_model "A new model"
description "Describe the system and the question you are asking."

var counter : 0..2 = 0

process A, B {
  var pc : {start, done} = start
  action step when pc = start {
    counter := counter + 1
    pc := done
  }
}

terminal A.pc = done and B.pc = done
invariant Bounded: counter <= 2
`;

export function NewModel() {
  const [msg, setMsg] = useState('');
  const create = async () => {
    try {
      const r = await api.createModel(STARTER, 'created from template');
      location.hash = `#/model/${r.model.slug}`;
    } catch (e) { setMsg(String((e as Error).message)); }
  };
  return (
    <main className="bazaar">
      <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 400 }}>Write a model</h1>
      <p style={{ color: 'var(--porcelain-dim)', maxWidth: '70ch' }}>Models are written in WML, a small typed language: bounded integers, booleans and enumerations; processes with guarded atomic actions; invariants, two liveness forms and explicit fairness. It cannot run code. See <code>docs/MODEL_LANGUAGE.md</code>.</p>
      <pre className="code">{STARTER}</pre>
      <button className="btn primary" onClick={() => void create()}>Create this model and open it</button>
      {msg && <p className="callout red">{msg}</p>}
    </main>
  );
}
