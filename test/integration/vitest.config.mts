import { defineConfig } from 'vitest/config';
import { sharedResolve } from '../../vitest.shared.mts';

/**
 * Integration tests: the worker, the real DAOs, and a real database.
 *
 * `node:sqlite` stands in for D1 and the migrations are applied for real, so a
 * foreign key or a PRAGMA that only holds in production fails here rather than
 * on the first deploy. It is slow enough -- and different enough in kind -- to
 * be a suite of its own, run separately from the mocked unit tests.
 *
 * `resolve` sits at the top level here rather than inside a `projects` entry:
 * this config has no projects, and an alias nested under `test` is ignored.
 *
 * Coverage is deliberately absent: these tests exist to exercise behaviour end
 * to end, and the unit suite owns the coverage floor.
 */
export default defineConfig({
  globals: true,
  resolve: sharedResolve,
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
  },
});
