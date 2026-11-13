#!/usr/bin/env node
// Command-line front end. Usage: node src/cli/witness.ts <command> [...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compileSource } from '../core/model/compile.ts';
import { check } from '../core/engine/check.ts';
import { formatDiagnostic } from '../core/diagnostics.ts';
import { buildReceipt, verifyReceipt, MAX_RECEIPT_BYTES } from '../core/receipt/receipt.ts';
import { exportTla } from '../core/tla/export.ts';
import { runTlcCrossCheck, tlcAvailability } from '../core/tla/tlc.ts';

const USAGE = `witness <command>
  check <model.witness> [--max-states N] [--max-depth N] [--time-ms N] [--receipt out.json] [--json]
  verify <receipt.json> [--no-rerun]
  export-tla <model.witness> [--out dir]
  tlc <model.witness> [--receipt out.json]     cross-check with TLC (needs Docker or Java)
  doctor`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(name: string): number | undefined {
  const v = arg(name);
  return v === undefined ? undefined : Number(v);
}

async function main(): Promise<number> {
  const [cmd, file] = process.argv.slice(2);
  switch (cmd) {
    case 'check':
    case 'tlc': {
      if (!file) { console.error(USAGE); return 2; }
      const src = readFileSync(file, 'utf8');
      const c = compileSource(src);
      for (const d of c.diagnostics) console.error(formatDiagnostic(d));
      if (!c.ok) return 2;
      const bounds = { maxStates: num('--max-states'), maxDepth: num('--max-depth'), timeLimitMs: num('--time-ms') };
      const { result } = check(c.model!, { bounds, includeGraph: false });
      let tlc;
      if (cmd === 'tlc') tlc = await runTlcCrossCheck(src, c.model!, result);
      if (process.argv.includes('--json')) console.log(JSON.stringify({ result, tlc }, null, 2));
      else {
        console.log(`${result.model.title}`);
        console.log(`verdict: ${result.verdict}   complete: ${result.complete}${result.capReason ? ` (cap: ${result.capReason})` : ''}`);
        console.log(`states: ${result.stats.states}  edges: ${result.stats.edges}  depth: ${result.stats.maxDepth}  time: ${result.stats.elapsedMs} ms`);
        for (const p of result.properties) {
          console.log(`  ${p.status.padEnd(17)} ${p.name}${p.trace ? `  (witness: ${p.trace.length} steps)` : ''}`);
          if (p.trace) for (const s of p.trace.steps) console.log(`      ${String(s.step).padStart(3)} ${s.stutter ? '(stutter)' : (s.action ?? '(initial)')}  ${s.changes.map((x) => `${x.variable}: ${x.from} → ${x.to}`).join(', ')}${p.trace.loopStart === s.step ? '   ← loop starts here' : ''}`);
        }
        if (tlc) {
          console.log(`TLC: ${tlc.note}`);
          for (const k of tlc.comparison ?? []) console.log(`  ${k.agree ? 'AGREE   ' : 'DIFFER  '} ${k.property}: internal ${k.internal} / TLC ${k.tlc}  ${k.note}`);
        }
      }
      const out = arg('--receipt');
      if (out) {
        const receipt = buildReceipt(src, result, { tlc });
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
        console.log(`receipt: ${out} (digest ${receipt.digest.slice(0, 16)}…; replay ${receipt.replay.every((r) => r.ok) ? 'OK' : 'FAILED'})`);
      }
      return result.verdict === 'ERROR' ? 1 : 0;
    }
    case 'verify': {
      if (!file) { console.error(USAGE); return 2; }
      const raw = readFileSync(file, 'utf8');
      if (raw.length > MAX_RECEIPT_BYTES) { console.error('REJECTED: receipt too large'); return 1; }
      let json: unknown;
      try { json = JSON.parse(raw); } catch { console.error('REJECTED: not valid JSON'); return 1; }
      const rep = verifyReceipt(json, { rerun: !process.argv.includes('--no-rerun') });
      for (const c of rep.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      console.log(rep.verdict);
      return rep.ok ? 0 : 1;
    }
    case 'export-tla': {
      if (!file) { console.error(USAGE); return 2; }
      const c = compileSource(readFileSync(file, 'utf8'));
      if (!c.ok) { c.diagnostics.forEach((d) => console.error(formatDiagnostic(d))); return 2; }
      const ex = exportTla(c.model!);
      const dir = arg('--out');
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/${ex.moduleName}.tla`, ex.tla);
        writeFileSync(`${dir}/${ex.moduleName}.cfg`, ex.cfgAll);
        console.log(`wrote ${dir}/${ex.moduleName}.tla and .cfg`);
      } else console.log(ex.tla + '\n---- cfg ----\n' + ex.cfgAll);
      return 0;
    }
    case 'doctor': {
      const t = await tlcAvailability();
      console.log(`node ${process.version}`);
      console.log(`TLC: ${t.available ? `available via ${t.runtime} (${t.version})` : `not available — ${t.reason}`}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
