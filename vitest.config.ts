import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'agents/test/**/*.test.ts',
            'skills/test/**/*.test.ts',
            'services/*/test/unit/**/*.test.ts',
            'tests/unit/**/*.test.ts',
            'tests/security/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'services/*/test/integration/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            'tests/licensing/**/*.test.ts',
          ],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts', 'tests/desktop/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
