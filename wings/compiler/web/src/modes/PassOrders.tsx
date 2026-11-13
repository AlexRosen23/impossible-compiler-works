// Cross-feature of THE IMPOSSIBLE COMPILER WORKS: hand a shipped example to the Witness wing, which model-checks
// every order (and repetition) of the optimizer passes against the reference interpreter. Server: bridge/pass-orders.ts.
import { useState } from 'react';
import { EXAMPLES, FAULT_LAB, useWB } from '../workbench.ts';

type Alphabet = 'safe' | 'mutant';
interface BridgeAnswer { verdict: string; slug: string; programs: number; diverging: number; shortestPassSequence: string[] | null; error?: string }

export function PassOrders() {
  // Only a shipped example, byte-for-byte, can be checked: the server rebuilds it from its own copy.
  const { source } = useWB();
  const seed = [...EXAMPLES, FAULT_LAB].find((e) => e.source === source)?.id ?? null;
  const [busy, setBusy] = useState<Alphabet | null>(null);
  const [answer, setAnswer] = useState<BridgeAnswer | null>(null);
  const run = async (alphabet: Alphabet) => {
    if (!seed) return;
    setBusy(alphabet); setAnswer(null);
    try {
      const res = await fetch('/api/bridge/pass-orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed, alphabet }) });
      setAnswer((await res.json()) as BridgeAnswer);
    } catch { setAnswer({ verdict: 'ERROR', slug: '', programs: 0, diverging: 0, shortestPassSequence: null, error: 'server offline' }); }
    setBusy(null);
  };
  return (
    <div className="pass-orders" data-testid="pass-orders">
      <div className="subhead">Every pass order · checked by the Witness wing{seed ? ` · ${seed}` : ''}</div>
      {!seed ? <p className="muted">Available when the editor holds an unmodified shipped example (for instance 13-optimizer-bench, or the fault lab's commuted-subtraction program).</p> : <>
        <p className="muted">Builds the graph of every IR module reachable by running constfold, cse and dce in any order, any number of times, labels each with the real VM against the reference interpreter, and model-checks it.</p>
        <button className="btn" disabled={busy !== null} onClick={() => run('safe')}>{busy === 'safe' ? 'checking…' : 'Check safe passes'}</button>{' '}
        <button className="btn" disabled={busy !== null} onClick={() => run('mutant')}>{busy === 'mutant' ? 'checking…' : 'Include the deliberately wrong pass'}</button>
      </>}
      {answer && <p role="status" data-testid="pass-orders-verdict">
        {answer.error ? <>Could not check: {answer.error}</> : <>
          <b>{answer.verdict}</b> · {answer.programs} IR modules, {answer.diverging} diverging
          {answer.shortestPassSequence ? <> · shortest: {answer.shortestPassSequence.join(' → ')}</> : null}
          {' · '}<a href={`/#/model/${answer.slug}`}>open the model in the Witness wing</a>
        </>}
      </p>}
    </div>
  );
}
