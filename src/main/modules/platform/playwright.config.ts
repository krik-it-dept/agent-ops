import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'platform.smoke.spec.ts',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: { headless: true },
  outputDir: '../../../../test-results/platform',
});
