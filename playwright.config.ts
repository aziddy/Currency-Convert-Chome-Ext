import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve-demo.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
