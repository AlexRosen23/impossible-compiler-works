import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, example, run } from './helpers.ts';

const expected = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/expected.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(path.join(ROOT, 'examples/catalog.json'), 'utf8'));

test('the catalog has at least 15 scenarios and every referenced model exists', () => {
  assert.ok(catalog.scenarios.length >= 15);
  for (const s of catalog.scenarios) {
    for (const f of [s.broken, s.fixed, ...(s.extra ?? [])]) assert.ok(existsSync(path.join(ROOT, 'examples', `${f}.witness`)), f);
  }
  const concepts = new Set(catalog.scenarios.flatMap((s: { concepts: string[] }) => s.concepts));
  for (const c of ['atomicity', 'locking', 'consensus assumptions', 'retries', 'idempotency', 'queue delivery', 'timeout', 'resource bounds', 'fairness', 'conservation']) assert.ok(concepts.has(c), c);
});

test('the catalog never hard-codes verdicts', () => {
  const text = readFileSync(path.join(ROOT, 'examples/catalog.json'), 'utf8');
  assert.doesNotMatch(text, /"(verdict|status|states)"\s*:/);
});

for (const f of readdirSync(path.join(ROOT, 'examples')).filter((x) => x.endsWith('.witness')).sort()) {
  const slug = f.replace('.witness', '');
  test(`regression: ${slug}`, () => {
    const exp = expected[slug];
    assert.ok(exp, `no expectation for ${slug}`);
    const { result } = run(example(slug), { maxStates: 500_000 });
    assert.equal(result.verdict, exp.verdict);
    assert.equal(result.stats.states, exp.states);
    assert.equal(result.stats.edges, exp.edges);
    for (const [name, want] of Object.entries(exp.properties) as [string, { status: string; witnessLength?: number }][]) {
      const p = result.properties.find((x) => x.name === name)!;
      assert.equal(p.status, want.status, name);
      if (want.witnessLength !== undefined) assert.equal(p.trace!.length, want.witnessLength, name);
    }
  });
}

test('every broken scenario violates something and every repaired one does not', () => {
  for (const s of catalog.scenarios) {
    if (s.broken === s.fixed) continue;
    assert.equal(run(example(s.broken)).result.verdict, 'VIOLATION_FOUND', s.broken);
    assert.equal(run(example(s.fixed)).result.verdict, 'NO_VIOLATION_IN_BOUNDED_MODEL', s.fixed);
  }
});
