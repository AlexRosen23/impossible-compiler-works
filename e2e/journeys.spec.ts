import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../evidence/screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function openAndRun(page: Page, slug: string, maxStates?: number) {
  await page.goto(`/#/model/${slug}`);
  await expect(page.getByTestId('diagnostics')).toContainText('model compiles');
  if (maxStates) await page.getByTestId('max-states').fill(String(maxStates));
  await page.getByTestId('run-check').click();
  await expect(page.getByTestId('verdict')).toBeVisible();
}

test('journey 1: broken two-thread counter -> real violating schedule -> step the exact trace', async ({ page }) => {
  await openAndRun(page, 'counter-race');
  await expect(page.getByTestId('verdict')).toHaveText('VIOLATION FOUND');
  await expect(page.getByTestId('property-list')).toContainText('NoLostUpdate');
  const theater = page.getByTestId('theater');
  for (const a of ['read', 'write']) await expect(theater).toContainText(a);
  await expect(theater).toContainText('Interference window');
  const scrub = page.getByTestId('trace-scrubber');
  await scrub.fill('2');
  await expect(page.getByTestId('state-rail')).toContainText('step 2');
  await shot(page, '01-counter-race-witness');
});

test('journey 2: atomic transaction -> complete bounded exploration, no violation (not a universal proof)', async ({ page }) => {
  await openAndRun(page, 'counter-atomic');
  await expect(page.getByTestId('verdict')).toHaveText('NO VIOLATION IN BOUNDED MODEL');
  await expect(page.getByText('exhaustive (no cap hit)')).toBeVisible();
  await page.getByRole('tab', { name: 'Invariant Hall' }).click();
  await expect(page.getByTestId('invariant-hall')).toContainText('Not a proof about any real system');
  await shot(page, '02-counter-atomic-verified');
});

test('journey 3: at-least-once queue duplicates output; idempotency fixes it', async ({ page }) => {
  await openAndRun(page, 'queue-redelivery');
  await expect(page.getByTestId('verdict')).toHaveText('VIOLATION FOUND');
  await expect(page.getByTestId('property-list').getByRole('button', { name: /^EffectAtMostOnce\W+VIOLATED$/ })).toBeVisible();
  await shot(page, '03a-queue-redelivery-duplicate');
  await openAndRun(page, 'queue-idempotent');
  await expect(page.getByTestId('property-list').getByRole('button', { name: /^EffectAtMostOnce\W+VERIFIED_BOUNDED$/ })).toBeVisible();
  await shot(page, '03b-queue-idempotent-fixed');
});

test('journey 4: resource deadlock -> state with no enabled action -> fix lock order', async ({ page }) => {
  await openAndRun(page, 'lock-order-deadlock');
  await expect(page.getByTestId('property-list').getByRole('button', { name: /^DeadlockFreedom\W+VIOLATED$/ })).toBeVisible();
  await expect(page.getByTestId('state-rail')).toContainText('No action is enabled');
  await shot(page, '04a-lock-order-deadlock');
  await openAndRun(page, 'lock-order-fixed');
  await expect(page.getByTestId('property-list').getByRole('button', { name: /^DeadlockFreedom\W+VERIFIED_BOUNDED$/ })).toBeVisible();
});

test('journey 5: export to TLA+, run TLC, compare with the internal checker', async ({ page }) => {
  await openAndRun(page, 'counter-race');
  await page.getByRole('tab', { name: 'Proof Observatory' }).click();
  await expect(page.getByTestId('tla-source')).toContainText('VARIABLES');
  const tlc = await (await page.request.get('/api/tlc')).json();
  test.skip(!tlc.available, `TLC not available: ${tlc.reason}`);
  await page.getByTestId('run-tlc').click();
  await expect(page.getByTestId('tlc-comparison')).toBeVisible({ timeout: 80_000 });
  await expect(page.getByTestId('proof-observatory')).toContainText('TLC AGREES');
  await expect(page.getByTestId('tlc-comparison')).toContainText('same shortest witness length (4 steps)');
  await shot(page, '05-tlc-cross-check');
});

test('journey 6: 50-state cap -> INCOMPLETE; receipt verifies, tampered receipt is rejected', async ({ page }) => {
  await openAndRun(page, 'state-explosion', 50);
  await expect(page.getByTestId('verdict')).toHaveText('INCOMPLETE');
  await expect(page.getByText(/INCOMPLETE — maxStates cap/)).toBeVisible();
  await page.getByRole('tab', { name: 'Witness Archive' }).click();
  const dl = page.waitForEvent('download');
  await page.getByTestId('download-receipt').click();
  expect((await dl).suggestedFilename()).toMatch(/^witness-receipt-run_.*\.json$/);
  await page.getByRole('button', { name: 'Show receipt' }).click();
  await page.getByTestId('verify-receipt').click();
  await expect(page.getByTestId('verify-result')).toContainText('VALID');
  await page.getByTestId('tamper-receipt').click();
  await expect(page.getByTestId('verify-result')).toContainText('REJECTED');
  await expect(page.getByTestId('verify-result')).toContainText('modified after it was issued');
  await shot(page, '06-incomplete-receipt-tampered');
});

test('the guided 90-second journey runs end to end', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/#/journey');
  const next = page.getByTestId('journey-next');
  for (let i = 0; i < 6; i++) {
    await expect(next).toBeEnabled({ timeout: 90_000 });
    await next.click();
    if (i === 0) await shot(page, '07a-journey-counterexample');
  }
  await expect(page.getByTestId('journey-verify')).toContainText('VALID', { timeout: 90_000 });
  await expect(page.getByTestId('journey-verify')).toContainText('REJECTED');
  await shot(page, '07b-journey-complete');
});

test('editing: diagnostics appear with positions and block running', async ({ page }) => {
  await page.goto('/#/model/counter-race');
  await expect(page.getByTestId('diagnostics')).toContainText('model compiles');
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\ninvariant Broken: missing_name = 1\n');
  await expect(page.getByTestId('diagnostics')).toContainText("Unknown name 'missing_name'");
  await expect(page.getByTestId('run-check')).toBeDisabled();
  await shot(page, '08-editor-diagnostics');
});

test('accessible fallbacks: state table, keyboard graph navigation, screen-reader trace lanes', async ({ page }) => {
  await openAndRun(page, 'counter-race');
  await page.getByRole('tab', { name: 'States (table)' }).click();
  const table = page.getByTestId('states-table');
  await expect(table.locator('tbody tr')).toHaveCount(13);
  await table.locator('tbody tr').nth(3).click();
  await expect(page.getByTestId('state-rail')).toContainText('state s3');
  const graph = page.getByTestId('state-graph');
  await graph.focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('state-rail')).toContainText('state s0');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('state-rail')).toContainText('step 1');
  await page.getByRole('tab', { name: 'Interleaving Theater' }).click();
  await expect(page.getByRole('table', { name: /Process lanes/ })).toBeVisible();
  await shot(page, '09-table-and-keyboard');
});

test('temporal observatory: weak fairness starves B, strong fairness does not', async ({ page }) => {
  await openAndRun(page, 'starvation-weak');
  await page.getByRole('tab', { name: 'Temporal Observatory' }).click();
  await expect(page.getByTestId('temporal-observatory')).toContainText('BEventuallyEnters');
  await expect(page.getByTestId('property-list').getByRole('button', { name: /^BEventuallyEnters\W+VIOLATED$/ })).toBeVisible();
  await shot(page, '10a-starvation-weak-lasso');
  await openAndRun(page, 'starvation-strong');
  await expect(page.getByTestId('property-list').getByRole('button', { name: /^BEventuallyEnters\W+VERIFIED_BOUNDED$/ })).toBeVisible();
});

test('mutation testing kills a mutant that removes the lock guard', async ({ page }) => {
  await openAndRun(page, 'mutex-test-and-set');
  await page.getByRole('tab', { name: 'Invariant Hall' }).click();
  await page.getByTestId('run-mutation').click();
  await expect(page.getByTestId('invariant-hall')).toContainText('mutants killed');
  await expect(page.getByTestId('invariant-hall')).toContainText('MutualExclusion');
  await shot(page, '11-mutation-testing');
});

test('compare broken and repaired runs at aligned transition points', async ({ page }) => {
  await openAndRun(page, 'inventory-race');
  await openAndRun(page, 'inventory-atomic');
  await page.getByRole('tab', { name: 'Witness Archive' }).click();
  const boxes = page.locator('input[type=checkbox]:not([disabled])');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByTestId('compare-runs').click();
  await expect(page.getByTestId('compare-summary')).toContainText('reachable set changed');
  await expect(page.getByTestId('compare')).toContainText('witnesses aligned by logical step');
  await shot(page, '12-compare-runs');
});

test('model titles cannot inject markup (XSS)', async ({ page }) => {
  const src = 'model xss "<img src=x onerror=window.__pwned=1>"\nvar x : 0..1 = 0\nprocess P { action a when x = 0 { x := 1 } }\nterminal x = 1\ninvariant I: x <= 1\n';
  const r = await (await page.request.post('/api/models', { data: { source: src } })).json();
  await page.goto(`/#/model/${r.model.slug}`);
  await page.getByTestId('run-check').click();
  await expect(page.getByTestId('verdict')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('accessibility: no serious or critical axe violations on the bazaar and a workspace', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('scenario-cards')).toBeVisible();
  const a = await new AxeBuilder({ page }).analyze();
  const bad = (x: typeof a) => x.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length}`);
  expect(bad(a)).toEqual([]);
  await shot(page, '00-model-bazaar');
  await openAndRun(page, 'counter-race');
  const b = await new AxeBuilder({ page }).exclude('.cm-editor').analyze();
  expect(bad(b)).toEqual([]);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('bazaar and workspace fit a phone without horizontal scrolling', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('scenario-cards')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(page, '13a-mobile-bazaar');
    await openAndRun(page, 'counter-race');
    await expect(page.getByTestId('verdict')).toHaveText('VIOLATION FOUND');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(page, '13b-mobile-workspace');
  });
});
