import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const srcPath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const apiSrcPath = srcPath('./apps/api/src');
const backgroundSrcPath = srcPath('./apps/background/src');
const backendDataSrcPath = srcPath('./packages/backend-data/src');
const backendErrorsSrcPath = srcPath('./packages/backend-errors/src');
const backendRuntimeSrcPath = srcPath('./packages/backend-runtime/src');
const backendServicesSrcPath = srcPath('./packages/backend-services/src');
const providerClientsSrcPath = srcPath('./packages/provider-clients/src');
const sharedSrcPath = srcPath('./packages/shared/src');
const webSrcPath = srcPath('./apps/web/src');
const cloudflareWorkersMockPath = srcPath('test/mocks/cloudflare-workers.ts');

/**
 * Shared by both projects.
 *
 * `cloudflare:workers` is a Workers-runtime module with no Node equivalent, so
 * it is aliased to a stub; the durable-object tests rely on that.
 */
const shared = {
  globals: true,
  coverage: {
    provider: 'v8' as const,
    reporter: ['text', 'lcov', 'html'],
    reportsDirectory: './coverage',
    include: [
      'apps/api/src/**/*.ts',
      'apps/background/src/**/*.ts',
      'apps/web/src/**/*.{ts,tsx}',
      'packages/**/src/**/*.ts',
    ],
    // `model` and `index` are type-only and re-exports; `generated` is a build
    // artefact. None of them contain logic worth a coverage target.
    //
    // The web `components` and view modules are excluded too: they are
    // presentational JSX whose behaviour is its rendering, and there are no
    // component tests. Measuring them would only report a number nobody is
    // acting on. What is measured is the logic under them -- `lib`, `hooks`,
    // `services` and `types`.
    exclude: [
      '**/*.test.{ts,tsx}',
      '**/*.d.ts',
      '**/index.ts',
      '**/types.d.ts',
      '**/model/**',
      '**/generated/**',
      'apps/web/src/components/**',
      'apps/web/src/main.tsx',
      'apps/web/src/SpaApp.tsx',
    ],
  },
  resolve: {
    alias: [
      { find: '@caldav-bridge/background', replacement: backgroundSrcPath },
      { find: '@caldav-bridge/backend-data', replacement: backendDataSrcPath },
      { find: '@caldav-bridge/backend-errors', replacement: backendErrorsSrcPath },
      { find: '@caldav-bridge/backend-runtime', replacement: backendRuntimeSrcPath },
      { find: '@caldav-bridge/backend-services', replacement: backendServicesSrcPath },
      { find: '@caldav-bridge/provider-clients', replacement: providerClientsSrcPath },
      { find: '@caldav-bridge/shared', replacement: sharedSrcPath },
      { find: 'cloudflare:workers', replacement: cloudflareWorkersMockPath },
      { find: /^@\//, replacement: `${apiSrcPath}/` },
      { find: /^~\//, replacement: `${webSrcPath}/` },
    ],
  },
};

/**
 * The web tests need a DOM and the backend tests do not, so they are separate
 * projects rather than one run that loads a DOM for everything. Splitting by
 * directory also means a test can be placed next to the subject it covers without
 * also having to declare how it has to be run.
 */
export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: { name: 'backend', environment: 'node', include: ['test/**/*.test.ts'], exclude: ['test/web/**'] },
      },
      {
        ...shared,
        test: { name: 'web', environment: 'happy-dom', include: ['test/web/**/*.test.{ts,tsx}'] },
      },
    ],
    coverage: {
      ...shared.coverage,
      // Raised from the previous floor of 45/35/50/45 once the untested DAOs,
      // the worker bases and the web logic were covered. A threshold nobody
      // reaches is not a threshold.
      thresholds: {
        statements: 87,
        branches: 77,
        functions: 88,
        lines: 90,
      },
    },
  },
});
