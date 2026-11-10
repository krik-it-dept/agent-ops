import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: { headless: true },
});
