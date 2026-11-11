import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    // Many tests use real temporary files, junctions and child processes; on a
    // busy Windows runner a single test can take longer than the default 5 s.
    testTimeout: 15_000,
  },
});
