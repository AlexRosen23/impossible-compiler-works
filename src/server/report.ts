// Self-contained interactive HTML report for one run. Every dynamic string is escaped; the
// receipt is embedded as inert JSON (no HTML parsing) for machine replay.
import type { Receipt } from '../core/receipt/receipt.ts';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface RunViewLike {
  id: string; kind: string; status: string; created_at: string; finished_at: string | null;
  model: { slug: string; title: string };
  revision: { rev: number; source_sha256: string };
  result: {
    verdict: string; complete: boolean; capReason: string | null; stats: Record<string, number>;
    properties: { name: string; status: string; text: string; note: string; trace?: { steps: { step: number; action: string | null; stutter?: boolean; changes: { variable: string; from: unknown; to: unknown }[]; state: Record<string, unknown> }[]; loopStart?: number } }[];
    tlc?: { note: string; comparison?: { property: string; internal: string; tlc: string; agree: boolean; note: string }[] };
    limitations: string[];
  };
  annotations: { property: string; text: string; created_at: string }[];
}

export function renderReport(run: RunViewLike, receipt: Receipt | null): string {
  const r = run.result;
  const props = r.properties.map((p) => `<tr><td>${esc(p.name)}</td><td class="s-${esc(p.status)}">${esc(p.status)}</td><td><code>${esc(p.text)}</code></td><td>${esc(p.note)}</td></tr>`).join('');
  const traces = r.properties.filter((p) => p.trace).map((p, k) => {
    const t = p.trace!;
    const vars = Object.keys(t.steps[0].state);
    const rows = t.steps.map((s) => `<tr data-step="${s.step}"${t.loopStart === s.step ? ' class="loop"' : ''}><td>${s.step}</td><td>${s.stutter ? '(stutter)' : esc(s.action ?? '(initial)')}</td>${vars.map((v) => `<td${s.changes.some((c) => c.variable === v) ? ' class="chg"' : ''}>${esc(s.state[v])}</td>`).join('')}</tr>`).join('');
    return `<section><h3>Witness for ${esc(p.name)} — ${t.steps.length - 1} step(s)${t.loopStart !== undefined ? `, loop back to step ${t.loopStart}` : ''}</h3>
      <label>Step <input type="range" min="0" max="${t.steps.length - 1}" value="${t.steps.length - 1}" data-trace="${k}" aria-label="Scrub witness ${esc(p.name)}"></label>
      <table class="trace" id="trace-${k}"><thead><tr><th>step</th><th>action</th>${vars.map((v) => `<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
  const tlc = r.tlc?.comparison ? `<h2>TLC cross-check</h2><p>${esc(r.tlc.note)}</p><table><tr><th>comparison</th><th>internal</th><th>TLC</th><th>agree</th><th>note</th></tr>${r.tlc.comparison.map((c) => `<tr><td>${esc(c.property)}</td><td>${esc(c.internal)}</td><td>${esc(c.tlc)}</td><td>${c.agree ? 'yes' : '<b>NO</b>'}</td><td>${esc(c.note)}</td></tr>`).join('')}</table>` : `<h2>TLC cross-check</h2><p>${esc(r.tlc?.note ?? 'Not run for this report (INTERNAL_ONLY).')}</p>`;
  const notes = run.annotations.length ? `<h2>Annotations</h2><ul>${run.annotations.map((a) => `<li><b>${esc(a.property)}</b>: ${esc(a.text)} <small>${esc(a.created_at)}</small></li>`).join('')}</ul>` : '';
  const receiptJson = receipt ? JSON.stringify(receipt).replace(/</g, '\\u003c') : 'null';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Witness report — ${esc(run.model.title)}</title>
<style>
:root{--void:#11101B;--ink:#20202E;--porcelain:#F0ECE4;--indigo:#9C9BDC;--gold:#C4A66E;--mint:#80B9A1;--red:#D07878}
body{background:var(--void);color:var(--porcelain);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:1100px}
h1{font-family:Georgia,serif;font-weight:400;color:var(--gold)}h2{color:var(--indigo);font-weight:500}
table{border-collapse:collapse;width:100%;margin:8px 0 20px;background:var(--ink)}td,th{border:1px solid #33334a;padding:4px 8px;text-align:left;font-size:13px}
code,pre{font-family:ui-monospace,Menlo,monospace}pre{background:var(--ink);padding:12px;overflow:auto}
.s-VIOLATED{color:var(--red);font-weight:600}.s-VERIFIED_BOUNDED{color:var(--mint)}.s-INCOMPLETE{color:var(--gold)}
.chg{color:var(--gold);font-weight:600}.loop td:first-child{border-left:3px solid var(--indigo)}tr.dim{opacity:.25}
.warn{border-left:3px solid var(--gold);padding-left:12px}
</style></head><body>
<h1>${esc(run.model.title)}</h1>
<p>Run <code>${esc(run.id)}</code> · ${esc(run.kind)} · model <code>${esc(run.model.slug)}</code> rev ${run.revision.rev} · source sha256 <code>${esc(run.revision.source_sha256.slice(0, 16))}…</code></p>
<p><b>Verdict: ${esc(r.verdict)}</b> · complete: ${r.complete ? 'yes' : `NO (cap ${esc(r.capReason)})`} · ${r.stats.states} states · ${r.stats.edges} transitions · depth ${r.stats.maxDepth}</p>
<div class="warn">${r.limitations.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
<h2>Properties</h2><table><tr><th>property</th><th>status</th><th>definition</th><th>evidence</th></tr>${props}</table>
${traces}${tlc}${notes}
<h2>Receipt</h2><p>${receipt ? `digest <code>${esc(receipt.digest)}</code>. Verify with <code>node src/cli/witness.ts verify receipt.json</code> after saving the JSON below.` : 'No receipt.'}</p>
<details><summary>Machine-readable receipt (replay bundle)</summary><pre id="receipt"></pre></details>
<script type="application/json" id="receipt-data">${receiptJson}</script>
<script>
document.getElementById('receipt').textContent = JSON.stringify(JSON.parse(document.getElementById('receipt-data').textContent), null, 2);
document.querySelectorAll('input[type=range][data-trace]').forEach(function (inp) {
  var rows = document.querySelectorAll('#trace-' + inp.dataset.trace + ' tbody tr');
  var upd = function () { rows.forEach(function (tr) { tr.classList.toggle('dim', Number(tr.dataset.step) > Number(inp.value)); }); };
  inp.addEventListener('input', upd); upd();
});
</script></body></html>`;
}
