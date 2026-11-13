import { useState } from 'react';
import { type AnyNode, children, type Span, typeNodeText } from '../../../core/index.ts';
import { useWB } from '../workbench.ts';

// Production rules as written in docs/FOLIO_LANGUAGE_SPEC.md §3, keyed by the AST node kinds they build.
export const GRAMMAR: { lhs: string; rhs: string; kinds: string[] }[] = [
  { lhs: 'program', rhs: '( fnDecl | dataDecl | sceneDecl )* EOF', kinds: ['Program'] },
  { lhs: 'fnDecl', rhs: '"fn" NAME "(" params? ")" "->" type block', kinds: ['FnDecl', 'Param'] },
  { lhs: 'dataDecl', rhs: '"data" NAME ":" type from STRING ";"', kinds: ['DataDecl'] },
  { lhs: 'sceneDecl', rhs: '"scene" STRING ( size N x N | frames N | background COLOR )* block', kinds: ['SceneDecl'] },
  { lhs: 'block', rhs: '"{" stmt* "}"', kinds: ['Block'] },
  { lhs: 'letStmt', rhs: '( "let" | "var" ) NAME ( ":" type )? "=" expr ";"', kinds: ['Let'] },
  { lhs: 'assignStmt', rhs: 'NAME "=" expr ";"', kinds: ['Assign'] },
  { lhs: 'ifStmt', rhs: '"if" expr block ( "else" ( ifStmt | block ) )?', kinds: ['If'] },
  { lhs: 'repeatStmt', rhs: '"repeat" NAME "in" ( expr ".." expr | expr ) block', kinds: ['Repeat'] },
  { lhs: 'returnStmt', rhs: '"return" expr ";"', kinds: ['Return'] },
  { lhs: 'assertStmt', rhs: '"assert" expr ( "," STRING )? ";"', kinds: ['Assert'] },
  { lhs: 'drawStmt', rhs: 'NAME "(" namedArgs? ")" ";"', kinds: ['Draw', 'NamedArg'] },
  { lhs: 'groupStmt', rhs: '"group" "(" namedArgs? ")" block', kinds: ['Group'] },
  { lhs: 'type', rhs: 'Number | Boolean | String | Color | Point | List "<" type ">"', kinds: ['TypeRef'] },
  { lhs: 'or / and', rhs: 'and ( "or" and )*   ·   equality ( "and" equality )*', kinds: [] },
  { lhs: 'equality', rhs: 'compare ( ( "==" | "!=" ) compare )?        (no chaining)', kinds: [] },
  { lhs: 'compare', rhs: 'additive ( ( "<" | "<=" | ">" | ">=" ) additive )?', kinds: [] },
  { lhs: 'additive / mult', rhs: 'mult ( ( "+" | "-" ) mult )*   ·   unary ( ( "*" | "/" | "%" ) unary )*', kinds: ['Binary'] },
  { lhs: 'unary', rhs: '( "-" | "not" ) unary | postfix', kinds: ['Unary'] },
  { lhs: 'postfix', rhs: 'primary ( "[" expr "]" | "." NAME )*', kinds: ['Index', 'Field'] },
  { lhs: 'primary', rhs: 'NUMBER | STRING | COLOR | true | false | NAME | NAME "(" args? ")" | "(" expr ")" | "[" args? "]"', kinds: ['Num', 'Str', 'Color', 'Bool', 'Name', 'Call', 'List'] },
];

function detail(n: AnyNode): string {
  switch (n.kind) {
    case 'Program': return '';
    case 'FnDecl': return `${n.name}(${n.params.map((p) => p.name).join(', ')}) -> ${typeNodeText(n.ret)}`;
    case 'DataDecl': return `${n.name} from "${n.fixture}"`;
    case 'SceneDecl': return JSON.stringify(n.title);
    case 'Param': return n.name;
    case 'Let': return `${n.mutable ? 'var' : 'let'} ${n.name}`;
    case 'Assign': return n.name;
    case 'Repeat': return n.name;
    case 'Draw': return n.prim;
    case 'NamedArg': return `${n.name}:`;
    case 'TypeRef': return typeNodeText(n);
    case 'Num': return String(n.value);
    case 'Str': return JSON.stringify(n.value).slice(0, 30);
    case 'Color': return n.value;
    case 'Bool': return String(n.value);
    case 'Name': return n.name;
    case 'Unary': case 'Binary': return n.op;
    case 'Call': return n.callee;
    case 'Field': return `.${n.field}`;
    default: return '';
  }
}

function Node({ n, depth, types, onPick, hot }: { n: AnyNode; depth: number; types: Map<number, string>; onPick(n: AnyNode): void; hot: number | null }) {
  const [open, setOpen] = useState(depth < 4);
  const kids = children(n);
  const ty = types.get(n.id);
  return (
    <li>
      <span className="tw" onClick={() => setOpen(!open)} aria-hidden="true">{kids.length ? (open ? '▾' : '▸') : ''}</span>
      <button className={`node ${hot === n.id ? 'hot' : ''}`} onClick={() => onPick(n)} aria-expanded={kids.length ? open : undefined} onKeyDown={(e) => { if (e.key === 'ArrowRight') setOpen(true); if (e.key === 'ArrowLeft') setOpen(false); }}>
        <span className="kind">{n.kind}</span><span className="detail">{detail(n)}</span>{ty && <span className="ty">: {ty}</span>}<span className="nid">#{n.id} · {n.span.line}:{n.span.col}</span>
      </button>
      {open && kids.length > 0 && <ul>{kids.map((k, i) => <Node key={i} n={k} depth={depth + 1} types={types} onPick={onPick} hot={hot} />)}</ul>}
    </li>
  );
}

export function Furnace() {
  const { compiled, select } = useWB();
  const [hot, setHot] = useState<AnyNode | null>(null);
  const toks = compiled.tokens.filter((t) => t.kind !== 'eof');
  const pick = (n: AnyNode) => { setHot(n); select(n.span); };
  const counts = toks.reduce<Record<string, number>>((m, t) => ((m[t.kind] = (m[t.kind] ?? 0) + 1), m), {});
  const lexParse = compiled.stages[0];
  return (
    <section className="pane" aria-label="Syntax Furnace">
      <div className="pane-head"><h2>B · The Syntax Furnace</h2><span>source → tokens → syntax tree</span></div>
      <div className="stats">
        <div className="stat"><b>{toks.length}</b><span>tokens</span></div>
        {Object.entries(counts).map(([k, n]) => <div className="stat" key={k}><b>{n}</b><span>{k}</span></div>)}
        <div className="stat"><b>{lexParse?.ms.toFixed(2) ?? '—'}</b><span>ms lex+parse</span></div>
        <div className="stat"><b>{compiled.program ? 'yes' : 'no'}</b><span>AST built</span></div>
      </div>
      <div className="cols" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane-body">
          <div className="subhead">Token stream (from core/lexer.ts, the same tokens that colour the editor)</div>
          <div className="tokens">{toks.map((t, i) => <button key={i} className={`tok tk-${t.kind}`} title={`${t.kind} ${t.span.line}:${t.span.col} [${t.span.start}, ${t.span.end})`} onClick={() => select(t.span as Span)}>{t.text.length > 24 ? t.text.slice(0, 22) + '…' : t.text}<small>{t.kind}</small></button>)}</div>
        </div>
        <div className="pane-body">
          <div className="subhead">Abstract syntax tree (node ids, spans and checked types)</div>
          {compiled.program ? <div className="tree"><ul><Node n={compiled.program} depth={0} types={compiled.check?.types ?? new Map()} onPick={pick} hot={hot?.id ?? null} /></ul></div> : <div className="empty">The parser could not build a tree. The diagnostics name the expected tokens.</div>}
        </div>
      </div>
      <div className="pane-foot" style={{ maxHeight: '30vh', overflow: 'auto' }}>
        <div className="subhead">Grammar rail · folio-grammar/0.1 {hot ? `· ${hot.kind} is built by the highlighted rule` : '· pick a node'}</div>
        <div className="grammar">{GRAMMAR.map((g) => <div key={g.lhs} className={`rule ${hot && g.kinds.includes(hot.kind) ? 'hot' : ''}`}><span className="lhs">{g.lhs}</span> := {g.rhs}</div>)}</div>
      </div>
    </section>
  );
}
