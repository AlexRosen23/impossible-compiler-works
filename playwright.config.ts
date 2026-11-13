import { defineConfig, devices } from '@playwright/test';

// One combined instance for both wings: API 5726, UI 5727 (spare test ports), its own databases.
// Witness wing journeys: e2e/. Compiler wing (formerly PAPER TIGER) IDE journeys: wings/compiler/e2e/.
const API = 5726;
const WEB = 5727;
export default defineConfig({
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { baseURL: `http://127.0.0.1:${WEB}`, trace: 'retain-on-failure' },
  webServer: {
    command: `rm -f data/e2e.db data/e2e.db-* data/e2e-compiler.sqlite* && npx vite build --config web/vite.config.ts >/dev/null && API_PORT=${API} WEB_PORT=${WEB} WITNESS_DB=data/e2e.db ./scripts/start.sh`,
    url: `http://127.0.0.1:${WEB}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'witness', testDir: 'e2e', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } },
    { name: 'compiler', testDir: 'wings/compiler/e2e', use: { ...devices['Desktop Chrome'], viewport: { width: 1512, height: 900 }, colorScheme: 'dark' } },
  ],
});
