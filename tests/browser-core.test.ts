// The checker core is shared by Node and the browser demo: one SHA-256, no static node: imports (apart from the
// TLC bridge, which needs Java and is never shipped to the browser), and a demo bundle with no loopback address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { sha256Hex } from '../src/core/hash.ts';

test('the shared pure SHA-256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ünïcödé 紙の虎 🐯', 'x'.repeat(10_000), 'step=1\ncounter=2']) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('src/core has no static node: import outside src/core/tla/tlc.ts', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const root = path.resolve('src/core');
  for (const f of walk(root).filter((x) => x.endsWith('.ts') && !x.endsWith(`${path.sep}tla${path.sep}tlc.ts`))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /^\s*import[^;]*from\s+['"]node:/m, `${path.relative(root, f)} must not import node: modules statically`);
  }
});

test('the demo build ships no loopback address or API port, in either wing', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'icw-demo-'));
  const prev = process.env.VITE_DEMO;
  process.env.VITE_DEMO = '1';
  try {
    await build({ configFile: path.resolve('web/vite.config.ts'), logLevel: 'silent', base: '/demos/x/', build: { outDir: out, emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 } });
    const files = [...readdirSync(path.join(out, 'assets')).map((f) => path.join(out, 'assets', f)), path.join(out, 'index.html'), path.join(out, 'compiler', 'index.html')];
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const bad of ['127.0.0.1', '5720', '5721', '5580']) assert.ok(!all.includes(bad), `demo bundle contains ${bad}`);
    assert.ok(all.includes('browser demo'));
    assert.ok(files.some((f) => /checker\.worker-.*\.js$/.test(f)), 'the checker runs in a module worker');
  } finally {
    if (prev === undefined) delete process.env.VITE_DEMO; else process.env.VITE_DEMO = prev;
    rmSync(out, { recursive: true, force: true });
  }
});
