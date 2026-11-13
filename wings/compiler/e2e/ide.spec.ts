import { expect, type Page, test } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `evidence/screenshots/${name}.png` });
async function replaceSource(page: Page, src: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(src);
}

test('1 · compile and run: all stages, a real drawing, frame scrubbing, oracle agreement', async ({ page }) => {
  await page.goto('/#/editorial/example/03-orrery');
  await expect(page.locator('.chip.ok').first()).toContainText('compiled');
  for (const stage of ['lex+parse', 'check', 'fixtures', 'lower', 'optimize', 'codegen', 'verify']) await expect(page.locator('.stage', { hasText: stage }).first()).not.toHaveClass(/fail/);
  await expect(page.locator('canvas[role=img]')).toHaveAttribute('aria-label', /12 circles|circles/);
  await expect(page.locator('.verdict')).toContainText('VM ≡ reference interpreter');
  await page.getByLabel('Frame').fill('30');
  await expect(page.locator('.transport .t')).toContainText('frame 30');
  await expect(page.locator('.verdict')).toContainText('VM ≡ reference interpreter');
  await shot(page, '01-editorial-compile-and-run');
});

test('2 · helpful failure: parse succeeds, check fails at the span, the fix recompiles', async ({ page }) => {
  await page.goto('/#/editorial/example/01-rainfall-almanac');
  await replaceSource(page, 'scene "Type Mismatch" {\n  let label = "radius";\n  circle(x: 40, y: 40, radius: label);\n}\n');
  const diag = page.locator('.diag').first();
  await expect(diag).toContainText('C002');
  await expect(diag).toContainText("circle's radius must be Number, found String");
  await expect(diag).toContainText('3:32');
  await expect(page.locator('.stage', { hasText: 'lex+parse' })).not.toHaveClass(/fail/);
  await expect(page.locator('.stage', { hasText: 'check' })).toHaveClass(/fail/);
  await shot(page, '02-helpful-failure');
  await replaceSource(page, 'scene "Type Mismatch" {\n  let label = "radius";\n  circle(x: 40, y: 40, radius: 12);\n  text(x: 60, y: 44, value: label);\n}\n');
  await expect(page.locator('.chip.ok').first()).toContainText('compiled');
  await expect(page.locator('.verdict')).toContainText('2 shapes');
});

test('3 · optimizer: real IR difference, identical outputs, measured steps', async ({ page }) => {
  await page.goto('/#/duel/example/13-optimizer-bench');
  await expect(page.locator('.ir-line.gone').first()).toBeVisible();
  await page.getByRole('button', { name: 'Check equivalence (all frames)' }).click();
  await expect(page.locator('.stat', { hasText: '30 frames' })).toContainText('identical');
  await expect(page.locator('.stat', { hasText: 'VM instructions executed' })).toContainText('1,765,080');
  await shot(page, '03-optimization-duel');
  // Turning every pass off leaves nothing struck through.
  for (const p of ['constfold', 'dce', 'cse']) await page.getByLabel(p).uncheck();
  await expect(page.locator('.ir-line.gone')).toHaveCount(0);
});

test('4 · debugger: breakpoint in a bounded loop, step, inspect, rewind, prove replay', async ({ page }) => {
  await page.goto('/#/theater/example/12-fibonacci-steps');
  const line9 = page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^9$/ });
  const box = (await line9.boundingBox())!;
  const gutter = (await page.locator('.cm-bp-gutter').boundingBox())!;
  await page.mouse.click(gutter.x + gutter.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('button', { name: /Continue ▸ \(1 bp\)/ })).toBeVisible();
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.locator('.stat', { hasText: 'source line' })).toContainText('source line 9');
  await expect(page.locator('.cm-debug-line')).toContainText('let next = a + b;');
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.locator('.dbg-frame').first()).toContainText('fib');
  await expect(page.locator('.dbg-frame').first()).toContainText('k');
  const step = await page.locator('.transport .t').textContent();
  await page.getByRole('button', { name: '◂ Back' }).click();
  await expect(page.locator('.transport .t')).not.toHaveText(step!);
  await page.getByRole('button', { name: 'Prove replay at this step' }).click();
  await expect(page.locator('.badge.mint')).toContainText('= fresh replay');
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByRole('button', { name: 'Step over' }).click();
  await shot(page, '04-bytecode-theater');
});

test('5 · bad optimization: the independent oracle catches it and the reducer shrinks it', async ({ page }) => {
  await page.goto('/#/gallery');
  await expect(page.locator('table.grid').first()).not.toContainText('✗');
  await page.getByRole('button', { name: 'Compile with the bad pass and compare' }).click();
  await expect(page.locator('.check', { hasText: 'DIVERGENCE DETECTED' })).toBeVisible();
  await page.getByRole('button', { name: 'Reduce the failing program' }).click();
  await expect(page.locator('.subhead', { hasText: 'Reduced reproducer' })).toContainText('still diverges');
  await page.getByRole('button', { name: 'Tamper with bytecode and load it' }).click();
  await expect(page.locator('.check.fail').first()).toContainText('hash mismatch');
  await shot(page, '05-failure-gallery-fault-lab');
});

test('6 · reproduce and tamper: server receipt reproduces, edits are rejected, bundle exports', async ({ page }) => {
  await page.goto('/#/cabinet/example/02-rainfall-ledger');
  await page.getByRole('button', { name: 'Record run on the server' }).click();
  await expect(page.locator('.badge.mint', { hasText: 'browser and server compiled the same bytes' })).toBeVisible();
  await page.getByRole('button', { name: 'Reproduce', exact: true }).click();
  await expect(page.locator('.subhead', { hasText: 'Reproduced from scratch on the server' })).toBeVisible();
  await expect(page.locator('.check.fail')).toHaveCount(0);
  for (const t of ['scene hash', 'source', 'bytecode']) {
    await page.getByRole('button', { name: `Tamper: ${t}` }).click();
    await expect(page.locator('.subhead', { hasText: /Tampered/ })).toContainText('rejected');
    await expect(page.locator('.check.fail').first()).toBeVisible();
  }
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export bundle' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^paper-tiger-run-[0-9a-f]{16}\.json$/);
  await shot(page, '06-proof-cabinet');
  const runs = await (await page.request.get('/runs')).json();
  expect(runs.runs.length).toBeGreaterThan(0);
});

test('save, reopen by deep link, history, conflict handling', async ({ page }) => {
  await page.goto('/#/editorial/example/04-spiral-garden');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page).toHaveURL(/#\/editorial\/project\/[0-9a-f]{8}/);
  const id = /project\/([0-9a-f]{8})/.exec(page.url())![1];
  await replaceSource(page, 'scene "Saved Twice" {\n  circle(x: 10, y: 10, radius: 5);\n}\n');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.locator('.toast')).toContainText('v2');
  // Someone else saves v3 behind our back.
  const r = await page.request.post(`/api/projects/${id}/versions`, { data: { baseVersion: `${id}:v2`, source: 'scene "Elsewhere" {}\n' } });
  expect(r.status()).toBe(201);
  await replaceSource(page, 'scene "Mine" {\n  circle(x: 20, y: 20, radius: 5);\n}\n');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('dialog', { name: 'Save conflict' })).toContainText('latest v3');
  await page.getByRole('button', { name: /Keep mine/ }).click();
  await expect(page.locator('.toast')).toContainText('v4');
  await page.goto(`/#/editorial/project/${id}`);
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('scene "Mine"');
  await page.getByRole('button', { name: /History/ }).click();
  await expect(page.getByRole('dialog', { name: 'Version history' }).locator('tbody tr')).toHaveCount(4);
});

test('mobile layout: readable and playable, no horizontal page scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/#/editorial/example/11-clockwork');
  await expect(page.locator('canvas[role=img]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('canvas[role=img]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'evidence/screenshots/07-mobile.png', fullPage: false });
  await ctx.close();
});

test('accessibility basics and injection safety', async ({ page }) => {
  page.on('dialog', () => { throw new Error('a FOLIO string opened a browser dialog'); });
  await page.goto('/#/editorial/example/01-rainfall-almanac');
  await expect(page.getByRole('tablist', { name: 'Workshop modes' }).getByRole('tab')).toHaveCount(8);
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !(b.textContent?.trim() || b.getAttribute('aria-label'))).length);
  expect(unnamed).toBe(0);
  await replaceSource(page, 'scene "<img src=x onerror=alert(1)>" {\n  text(x: 10, y: 20, value: "<script>alert(1)</script><img src=x onerror=alert(2)>");\n}\n');
  await expect(page.locator('.verdict')).toContainText('1 shapes');
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('script:not([type=module])').count()).toBe(0);
  // Keyboard: the mode tabs are reachable and switch modes.
  await page.getByRole('tab', { name: /Type Observatory/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/observatory/);
});

test('a crafted project deep link never steers the IDE to another API path', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (r) => seen.push(new URL(r.url()).pathname));
  await page.goto('/#/editorial/project/..%2F..%2Fapi%2Fcorpus%3F');
  await expect(page.getByRole('tablist', { name: 'Workshop modes' })).toBeVisible();
  await page.evaluate(() => { location.hash = '#/editorial/project/..%2Fruns'; });
  await page.waitForTimeout(300);
  expect(seen.filter((p) => p.startsWith('/api/projects/'))).toEqual([]);
  expect(seen).not.toContain('/api/corpus');
  expect(seen).not.toContain('/api/runs');
});
