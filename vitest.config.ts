import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
    coverage: {
      enabled: false,
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 55,
      },
      include: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts', 'packages/database/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/env.ts',
        '**/index.ts',
        'packages/database/src/client.ts',
        '**/routes/**',
      ],
    },
  },
});
