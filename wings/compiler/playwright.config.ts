import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5590', viewport: { width: 1512, height: 900 }, colorScheme: 'dark' },
  webServer: {
    command: 'rm -f var/e2e.sqlite* && npm run build >/dev/null && PT_PORT=5590 PT_STATIC=1 PT_DB=var/e2e.sqlite NODE_NO_WARNINGS=1 node server/index.ts',
    url: 'http://127.0.0.1:5590/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
