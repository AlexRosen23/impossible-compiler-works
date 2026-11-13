import { defineConfig, devices } from '@playwright/test';

// A separate instance on the e2e helper ports (5722 API, 5723 UI) with its own database.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results',
  use: { baseURL: 'http://127.0.0.1:5723', trace: 'retain-on-failure', viewport: { width: 1600, height: 1000 } },
  webServer: {
    command: 'rm -f data/e2e.db data/e2e.db-* && npx vite build --config web/vite.config.ts >/dev/null && API_PORT=5722 WEB_PORT=5723 WITNESS_DB=data/e2e.db ./scripts/start.sh',
    cwd: '..',
    url: 'http://127.0.0.1:5723/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
});
