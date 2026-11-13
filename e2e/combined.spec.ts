// THE IMPOSSIBLE COMPILER WORKS: one shell over both wings, and the cross-feature from the Compiler wing into the
// Witness wing.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FAULT_LAB = readFileSync('wings/compiler/examples/fault-lab-commute.folio', 'utf8');

test('both wings carry the shared shell with the new name and the visible Formerly line', async ({ page }) => {
  for (const [url, wing] of [['/', 'Witness wing'], ['/compiler/', 'Compiler wing']] as const) {
    await page.goto(url);
    const shell = page.getByTestId('icw-shell');
    await expect(shell).toContainText('THE IMPOSSIBLE COMPILER WORKS');
    await expect(page.getByTestId('icw-formerly')).toHaveText('Formerly Paper Tiger Compiler Works and The Impossible Witness');
    await expect(shell.getByRole('link', { name: wing })).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveTitle(/THE IMPOSSIBLE COMPILER WORKS/);
  }
});

test('cross-feature: every pass order of the fault-lab seed is model-checked and the counterexample opens in the Witness wing', async ({ page }) => {
  await page.goto('/compiler/#/duel/example/13-optimizer-bench');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(FAULT_LAB);
  await expect(page.getByTestId('pass-orders')).toContainText('fault-lab-commute');
  const panel = page.getByTestId('pass-orders');
  await panel.getByRole('button', { name: 'Check safe passes' }).click();
  await expect(page.getByTestId('pass-orders-verdict')).toContainText('NO_DIVERGENCE_IN_ANY_PASS_ORDER');
  await panel.getByRole('button', { name: 'Include the deliberately wrong pass' }).click();
  const verdict = page.getByTestId('pass-orders-verdict');
  await expect(verdict).toContainText('DIVERGENCE_FOUND');
  await expect(verdict).toContainText('shortest: BAD_cse_commute_all');
  await page.screenshot({ path: 'evidence/screenshots/icw-cross-feature-pass-orders.png' });
  await verdict.getByRole('link', { name: /open the model in the Witness wing/ }).click();
  await expect(page).toHaveURL(/\/#\/model\/pass-orders-fault-lab-commute-mutant/);
  await expect(page.getByText('OptimizedMatchesReference').first()).toBeVisible();
});
