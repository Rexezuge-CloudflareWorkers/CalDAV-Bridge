import { defineConfig } from 'vitest/config';
import { coverageThresholds, sharedCoverage, sharedResolve } from './vitest.shared.mts';

/**
 * The web tests need a DOM and the backend tests do not, so they are separate
 * projects rather than one run that loads a DOM for everything. Splitting by
 * directory also means a test can be placed next to the subject it covers
 * without also having to declare how it has to be run.
 *
 * `test/integration/` is a fourth suite with a config of its own; see
 * `test/integration/vitest.config.mts`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        globals: true,
        ...sharedCoverage,
        resolve: sharedResolve,
        test: {
          name: 'backend',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/web/**', 'test/integration/**'],
        },
      },
      {
        globals: true,
        ...sharedCoverage,
        resolve: sharedResolve,
        test: { name: 'web', environment: 'happy-dom', include: ['test/web/**/*.test.{ts,tsx}'] },
      },
    ],
    coverage: {
      ...sharedCoverage,
      thresholds: coverageThresholds,
    },
  },
});
