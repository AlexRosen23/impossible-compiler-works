// TLC adapter: runs the pinned tla2tools.jar in a bounded, sandboxed subprocess and parses its
// machine-readable (-tool) output. No shell is involved: every process is started with an
// argument vector. See docs/TLC_COMPATIBILITY.md and docs/SECURITY.md.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompiledModel } from '../model/ir.ts';
import type { CheckResult } from '../engine/check.ts';
import { exportTla, type TlaExport } from './export.ts';
import { replayTrace, type ReplayStep } from '../replay/replay.ts';
import type { TlcRecord } from '../receipt/receipt.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const TLC_PIN = {
  release: 'v1.7.4',
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
  sha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88',
  bytes: 2274532,
  license: 'MIT (tlaplus/tlaplus)',
};
// A JVM image that is already present on this machine, pinned by digest (never pulled implicitly).
export const DEFAULT_JAVA_IMAGE = 'quay.io/keycloak/keycloak@sha256:0aae0de7fca85525f727d3354df17896092de8bb26ae4c12d89c77e5df8cbce4';

export function jarPath(): string {
  return process.env.WITNESS_TLA2TOOLS ?? path.join(ROOT, 'tools', 'tla2tools.jar');
}

export interface Availability {
  available: boolean;
  runtime?: 'docker' | 'java';
  version?: string;
  jarSha256?: string;
  reason?: string;
}

let cachedAvail: Availability | null = null;

export function verifyJar(): { ok: boolean; sha256?: string; reason?: string } {
  const p = jarPath();
  if (!existsSync(p)) return { ok: false, reason: `tla2tools.jar not found at tools/ (run scripts/setup)` };
  const buf = readFileSync(p);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== TLC_PIN.sha256) return { ok: false, sha256: sha, reason: `tla2tools.jar checksum ${sha.slice(0, 12)}… does not match the pinned ${TLC_PIN.release} checksum` };
  return { ok: true, sha256: sha };
}

function hostJavaWorks(): boolean {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

function dockerImagePresent(image: string): boolean {
  const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 8000 });
  return r.status === 0;
}

export async function tlcAvailability(force = false): Promise<Availability> {
  if (cachedAvail && !force) return cachedAvail;
  const jar = verifyJar();
  if (!jar.ok) return (cachedAvail = { available: false, reason: jar.reason });
  const pref = process.env.WITNESS_TLC_RUNTIME ?? 'auto';
  let runtime: 'docker' | 'java' | undefined;
  if ((pref === 'auto' || pref === 'java') && hostJavaWorks()) runtime = 'java';
  else if ((pref === 'auto' || pref === 'docker') && dockerImagePresent(javaImage())) runtime = 'docker';
  if (!runtime) {
    return (cachedAvail = { available: false, jarSha256: jar.sha256, reason: 'no Java runtime: host `java` is missing and the pinned JVM Docker image is not present (see docs/TLC_COMPATIBILITY.md)' });
  }
  return (cachedAvail = { available: true, runtime, version: `TLC ${TLC_PIN.release} (tla2tools.jar sha256 ${jar.sha256!.slice(0, 12)}…)`, jarSha256: jar.sha256 });
}

function javaImage(): string {
  return process.env.WITNESS_TLC_IMAGE ?? DEFAULT_JAVA_IMAGE;
}

export interface TlcRun {
  config: string;
  status: 'NO_ERROR' | 'INVARIANT_VIOLATED' | 'DEADLOCK' | 'TEMPORAL_VIOLATED' | 'TLC_ERROR' | 'TIMEOUT';
  violated?: string;
  distinctStates?: number;
  generatedStates?: number;
  depth?: number;
  trace?: ReplayStep[];
  loopStart?: number;
  stutterForever?: boolean;
  version?: string;
  message?: string;
  elapsedMs: number;
  raw: string;
}

/** Run TLC once on (module, cfg) inside a fresh temp dir. Hard timeout and memory caps. */
export async function runTlc(exp: TlaExport, cfg: string, configName: string, opts: { timeoutMs?: number } = {}): Promise<TlcRun> {
  const avail = await tlcAvailability();
  if (!avail.available) throw new Error(avail.reason);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-tlc-'));
  const t0 = Date.now();
  try {
    writeFileSync(path.join(dir, `${exp.moduleName}.tla`), exp.tla);
    writeFileSync(path.join(dir, `${exp.moduleName}.cfg`), cfg);
    const tlcArgs = ['-XX:+UseParallelGC', '-Xmx512m', '-cp', '', 'tlc2.TLC', '-tool', '-workers', '1', '-deadlock', '-metadir', '', '-config', `${exp.moduleName}.cfg`, exp.moduleName];
    // `-deadlock` would DISABLE deadlock checking; remove it — deadlock checking is controlled by CHECK_DEADLOCK in the cfg.
    tlcArgs.splice(tlcArgs.indexOf('-deadlock'), 1);
    let cmd: string;
    let argv: string[];
    const name = `witness-tlc-${randomBytes(6).toString('hex')}`;
    if (avail.runtime === 'docker') {
      tlcArgs[tlcArgs.indexOf('-cp') + 1] = '/opt/tla2tools.jar';
      tlcArgs[tlcArgs.indexOf('-metadir') + 1] = '/work/states';
      cmd = 'docker';
      argv = [
        'run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--memory', '768m', '--cpus', '1',
        '--pids-limit', '256', '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-v', `${dir}:/work`, '-v', `${jarPath()}:/opt/tla2tools.jar:ro`, '-w', '/work', '--entrypoint', 'java', javaImage(), ...tlcArgs,
      ];
    } else {
      tlcArgs[tlcArgs.indexOf('-cp') + 1] = jarPath();
      tlcArgs[tlcArgs.indexOf('-metadir') + 1] = path.join(dir, 'states');
      cmd = 'java';
      argv = tlcArgs;
    }
    const raw = await new Promise<{ out: string; timedOut: boolean }>((resolve) => {
      const child = spawn(cmd, argv, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const MAX_OUT = 4 * 1024 * 1024;
      const onData = (b: Buffer) => { if (out.length < MAX_OUT) out += b.toString('utf8'); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (avail.runtime === 'docker') spawnSync('docker', ['kill', name], { timeout: 10_000 });
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('close', () => { clearTimeout(timer); resolve({ out, timedOut }); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ out: out + `\n[spawn error] ${e.message}`, timedOut }); });
    });
    const parsed = parseTlcOutput(raw.out, exp);
    return { ...parsed, config: configName, status: raw.timedOut ? 'TIMEOUT' : parsed.status, elapsedMs: Date.now() - t0, raw: raw.out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Msg { code: number; severity: number; body: string }

export function splitMessages(out: string): Msg[] {
  const msgs: Msg[] = [];
  const re = /@!@!@STARTMSG (\d+):(\d+) @!@!@\n([\s\S]*?)@!@!@ENDMSG \1 @!@!@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) msgs.push({ code: Number(m[1]), severity: Number(m[2]), body: m[3].trim() });
  return msgs;
}

function parseValue(s: string): number | boolean | string | undefined {
  const t = s.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  const q = /^"([A-Za-z0-9_]*)"$/.exec(t);
  if (q) return q[1];
  return undefined;
}

/** Parse TLC -tool output into a status, counts and (if any) a trace in WML terms. */
export function parseTlcOutput(out: string, exp: TlaExport, model?: CompiledModel): Omit<TlcRun, 'config' | 'elapsedMs' | 'raw'> {
  const msgs = splitMessages(out);
  const nameToVar = new Map(exp.varNames.map((n, i) => [n, i]));
  const varLabel = (i: number) => (model ? model.vars[i].name : exp.varNames[i]);
  void varLabel;
  const res: Omit<TlcRun, 'config' | 'elapsedMs' | 'raw'> = { status: 'TLC_ERROR' };
  const steps: ReplayStep[] = [];
  const watNames = exp.varNames;
  for (const msg of msgs) {
    switch (msg.code) {
      case 2262: res.version = msg.body.split('\n')[0]; break;
      case 2193: if (res.status === 'TLC_ERROR') res.status = 'NO_ERROR'; break;
      case 2107: case 2110: {
        res.status = 'INVARIANT_VIOLATED';
        const v = /Invariant (\S+) is violated/.exec(msg.body);
        if (v) res.violated = v[1];
        break;
      }
      case 2114: res.status = 'DEADLOCK'; break;
      case 2116: res.status = 'TEMPORAL_VIOLATED'; break;
      case 2199: {
        const c = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(msg.body);
        if (c) { res.generatedStates = Number(c[1].replace(/,/g, '')); res.distinctStates = Number(c[2].replace(/,/g, '')); }
        break;
      }
      case 2194: {
        const d = /depth of the complete state graph search is (\d+)/.exec(msg.body);
        if (d) res.depth = Number(d[1]);
        break;
      }
      case 2217: {
        const lines = msg.body.split('\n');
        const head = /^(\d+): <([^\s>]+)/.exec(lines[0]);
        const state: Record<string, number | boolean | string> = {};
        for (const line of lines.slice(1)) {
          const a = /^(?:\/\\ )?([A-Za-z0-9_]+) = (.*)$/.exec(line.trim());
          if (!a) continue;
          const vi = nameToVar.get(a[1]);
          const pv = parseValue(a[2]);
          if (vi === undefined || pv === undefined) continue;
          state[watNames[vi]] = pv;
        }
        const op = head?.[2] ?? '';
        steps.push({ action: op === 'Initial' ? null : (exp.opToLabel[op] ?? op), state });
        break;
      }
      case 2218: { // N: Stuttering
        const prev = steps[steps.length - 1];
        if (prev) { steps.push({ action: null, state: { ...prev.state }, stutter: true }); res.loopStart = steps.length - 2; res.stutterForever = true; }
        break;
      }
      case 2122: { // N: Back to state M: <Action ...>
        // TLC 2.19 prints "M: Back to state: <Action ...>" (M = 1-based target state)
        const b = /^(\d+): Back to state(?: (\d+))?:?\s*(?:<([^\s>]+))?/.exec(msg.body);
        if (b) {
          const target = Number(b[2] ?? b[1]) - 1;
          if (steps[target]) {
            steps.push({ action: b[3] ? (exp.opToLabel[b[3]] ?? b[3]) : null, state: { ...steps[target].state } });
            res.loopStart = target;
          }
        }
        break;
      }
      default:
        if (msg.severity === 1 && ![2110, 2107, 2114, 2116, 2121, 2264].includes(msg.code) && res.status === 'TLC_ERROR') {
          res.message = msg.body.slice(0, 500);
        }
    }
  }
  if (steps.length) res.trace = steps;
  if (res.status === 'TLC_ERROR' && !res.message) res.message = out.slice(-500);
  return res;
}

/** Convert a TLC trace (TLA names) into WML variable names for replay. */
function toWml(model: CompiledModel, exp: TlaExport, steps: ReplayStep[]): ReplayStep[] {
  return steps.map((s) => {
    const state: Record<string, number | boolean | string> = {};
    model.vars.forEach((v, i) => {
      const val = s.state[exp.varNames[i]];
      if (val !== undefined) state[v.name] = val;
    });
    return { ...s, state };
  });
}

/** Run the TLC cross-check corpus for one model and compare with the internal result. */
export async function runTlcCrossCheck(source: string, model: CompiledModel, internal: CheckResult, opts: { timeoutMs?: number } = {}): Promise<TlcRecord> {
  const avail = await tlcAvailability();
  if (!avail.available) {
    return { available: false, note: `INTERNAL_ONLY: TLC not run — ${avail.reason}` };
  }
  const exp = exportTla(model);
  const results: NonNullable<TlcRecord['results']> = [];
  const comparison: NonNullable<TlcRecord['comparison']> = [];
  let version: string | undefined;
  const byName = new Map(internal.properties.map((p) => [p.name, p]));
  const domainViolated = byName.get('TypeOK')?.status === 'VIOLATED';

  for (const c of exp.configs) {
    const run = await runTlc(exp, c.cfg, c.name, opts);
    version ??= run.version;
    let property = c.purpose;
    let tlcStatus: string = run.status;
    let replayNote = '';
    let replayOk = true;
    if (run.trace && run.status !== 'NO_ERROR') {
      const steps = toWml(model, exp, run.trace);
      const kind = run.status === 'INVARIANT_VIOLATED' ? (run.violated === 'TypeOK' ? 'domain' : 'invariant') : run.status === 'DEADLOCK' ? 'deadlock' : 'liveness';
      if (kind === 'domain') {
        replayNote = ' (TLC TypeOK witness: last state is out of domain; replayed as a domain claim)';
        const last = steps[steps.length - 1].state;
        const bad = model.vars.find((v) => v.type.kind === 'int' && typeof last[v.name] === 'number' && ((last[v.name] as number) < (v.type as { min: number }).min || (last[v.name] as number) > (v.type as { max: number }).max));
        const r = replayTrace(source, steps, { kind: 'domain', property: 'TypeOK', badWrite: bad ? { variable: bad.name, value: last[bad.name] as number } : undefined });
        replayNote += r.ok ? ' — independent replay OK' : ` — independent replay FAILED: ${r.reason}`;
        replayOk = r.ok;
      } else {
        const propName = kind === 'deadlock' ? 'DeadlockFreedom' : c.purpose;
        const r = replayTrace(source, steps, { kind: kind as 'invariant' | 'deadlock' | 'liveness', property: propName, loopStart: run.loopStart, stutterForever: run.stutterForever });
        replayNote = r.ok ? ' — TLC trace re-derived by the independent replay evaluator' : ` — independent replay of TLC trace FAILED: ${r.reason}`;
        replayOk = r.ok;
      }
    }
    if (c.name === 'full') {
      property = 'TypeOK';
      results.push({ property: 'StateCount', status: run.status, distinctStates: run.distinctStates });
      if (run.status === 'NO_ERROR') {
        const agree = run.distinctStates === internal.stats.states && internal.complete;
        comparison.push({
          property: 'StateCount', internal: `${internal.stats.states} states${internal.complete ? '' : ' (INCOMPLETE)'}`, tlc: `${run.distinctStates} distinct states`, agree,
          note: agree ? 'identical reachable-state count' : internal.complete ? 'state counts differ — see docs/TLC_COMPATIBILITY.md' : 'internal run was capped, so counts are not comparable',
        });
      } else if (domainViolated) {
        comparison.push({ property: 'StateCount', internal: `${internal.stats.states} states`, tlc: 'stopped at TypeOK', agree: true, note: 'not comparable: TLC stops at the first out-of-domain state, the internal explorer refuses to add it' });
      }
    }
    const internalProp = byName.get(property);
    const internalStatus = internalProp?.status ?? 'NOT_RUN';
    const tlcVerdict = run.status === 'NO_ERROR' ? 'NO_ERROR' : run.status;
    results.push({ property, status: tlcVerdict, distinctStates: run.distinctStates, traceLength: run.trace ? run.trace.length - 1 : undefined });
    const internalViolated = internalStatus === 'VIOLATED';
    const tlcViolated = ['INVARIANT_VIOLATED', 'DEADLOCK', 'TEMPORAL_VIOLATED'].includes(run.status);
    let agree = false;
    let note = '';
    if (run.status === 'TLC_ERROR' || run.status === 'TIMEOUT') {
      note = `TLC did not finish (${run.status}): ${run.message ?? ''}`.slice(0, 300);
    } else if (internalStatus === 'INCOMPLETE') {
      note = 'internal run was INCOMPLETE; no comparison';
    } else {
      agree = internalViolated === tlcViolated;
      const il = internalProp?.trace?.length;
      const tl = run.trace ? run.trace.length - 1 : undefined;
      if (agree && internalViolated && il !== undefined && tl !== undefined) {
        if (internalProp?.kind === 'eventually' || internalProp?.kind === 'leadsto') note = `both report a violation; lasso lengths ${il} (internal) vs ${tl} (TLC) — TLC does not promise a shortest lasso`;
        else note = il === tl ? `same shortest witness length (${il} steps)` : `witness lengths differ: ${il} internal vs ${tl} TLC`;
        if (il !== tl && internalProp?.kind !== 'eventually' && internalProp?.kind !== 'leadsto') agree = false;
      } else note = agree ? (tlcViolated ? 'both report a violation' : 'both report no violation') : 'VERDICTS DIFFER';
    }
    comparison.push({ property, internal: internalStatus, tlc: tlcVerdict, agree: agree && replayOk, note: note + replayNote });
  }
  const allAgree = comparison.every((c) => c.agree);
  return {
    available: true,
    version: version ?? avail.version,
    jarSha256: avail.jarSha256,
    runtime: avail.runtime === 'docker' ? `docker (${javaImage().split('@')[0]}, --network none, 768 MB, 1 CPU)` : 'host java',
    results,
    comparison,
    note: `${allAgree ? 'TLC AGREES' : 'TLC DIFFERS'} on ${comparison.filter((c) => c.agree).length}/${comparison.length} comparisons (${version ?? ''})`,
  };
}
