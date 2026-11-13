import { useEffect, useState } from 'react';
import { EXAMPLES, FAILURES, type Mode, useWB } from './workbench.ts';

interface Step { mode: Mode; title: string; body: string; load?: () => { source: string; label: string } | null }
const ex = (id: string) => () => { const e = EXAMPLES.find((x) => x.id.startsWith(id))!; return { source: e.source, label: e.title }; };
const STEPS: Step[] = [
  { mode: 'editorial', load: ex('03'), title: '1 · Source becomes a scene', body: 'A FOLIO program on the left; the compiler pipeline in the middle with each stage’s real timing and output hash; the VM’s output on the right. Press Play: every frame is the same pure program evaluated at a different time.' },
  { mode: 'furnace', title: '2 · Tokens and syntax', body: 'These are the lexer’s actual tokens (they also colour the editor) and the parser’s tree. Click any node: the editor selects its exact source span and the grammar rail lights up the rule that built it.' },
  { mode: 'editorial', load: () => { const f = FAILURES.find((x) => x.id === 'type-mismatch')!; return { source: f.source, label: f.title }; }, title: '3 · A helpful failure', body: 'This program parses but does not type-check: the pipeline stops at check with C002 at the exact span: a String where radius needs a Number. Change `radius: label` to `radius: 12` and it compiles again.' },
  { mode: 'observatory', load: ex('04'), title: '4 · How types were derived', body: 'Scopes, symbols and the derivation trace: every expression with its type and the rule that produced it. Nothing here is guessed. It is the checker’s own side tables.' },
  { mode: 'duel', load: ex('13'), title: '5 · Optimization, verified', body: 'Before and after IR with the removed instructions struck through. Press "Check equivalence": the optimized VM, the unoptimized VM and the independent AST interpreter must produce byte-identical scenes. Speed-ups are measured, and reported even when they are small.' },
  { mode: 'theater', load: ex('12'), title: '6 · The debugger', body: 'Set a breakpoint in the gutter, Continue, then step through real bytecode with the stack and locals. Drag the step slider back in time, then press "Prove replay": a rewound state and a fresh replay hash identically.' },
  { mode: 'gallery', title: '7 · The fault lab', body: 'A deliberately wrong pass treats subtraction as commutative. Compile with it and the reference interpreter catches the divergence; Reduce shrinks the failing program automatically.' },
  { mode: 'cabinet', load: ex('02'), title: '8 · Proof', body: 'Record the run: the server recompiles in its own process and stores a receipt. Reproduce it, then tamper with the hash, the source or the bytecode and watch each one get rejected. The same check runs from the CLI: npm run reproduce.' },
];

export function Tour({ onClose }: { onClose(): void }) {
  const { setMode, load } = useWB();
  const [i, setI] = useState(0);
  const s = STEPS[i];
  useEffect(() => { setMode(s.mode); const l = s.load?.(); if (l) load(l.source, l.label); }, [i]);
  return (
    <aside className="tour" role="dialog" aria-label="Guided tour">
      <div className="t-head"><span>GUIDED TOUR · {i + 1}/{STEPS.length} · ~90 s</span><button className="btn ghost" onClick={onClose} aria-label="Close the tour">×</button></div>
      <div className="t-body"><h3>{s.title}</h3><p>{s.body}</p></div>
      <div className="t-foot"><button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button><button className="btn primary" onClick={() => (i + 1 < STEPS.length ? setI(i + 1) : onClose())}>{i + 1 < STEPS.length ? 'Next' : 'Finish'}</button></div>
    </aside>
  );
}
