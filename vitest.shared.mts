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
 * How a specifier is resolved, shared by every suite.
 *
 * `cloudflare:workers` is a Workers-runtime module with no Node equivalent, so
 * it is aliased to a stub; the durable-object tests rely on that. The
 * `@caldav-bridge/*` aliases point at source rather than at built output, so a
 * test exercises the code the worker would run without a build step.
 */
export const sharedResolve = {
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
};

/**
 * What is measured, shared by every suite that measures it.
 */
export const sharedCoverage = {
  provider: 'v8' as const,
  reporter: ['text', 'lcov', 'html'],
  reportsDirectory: './coverage',
  include: ['apps/api/src/**/*.ts', 'apps/background/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'packages/**/src/**/*.ts'],
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
};

/**
 * The floor, kept beside the rules it measures.
 *
 * Raised from the previous floor of 45/35/50/45 once the untested DAOs,
 * the worker bases and the web logic were covered. A threshold nobody
 * reaches is not a threshold.
 */
export const coverageThresholds = {
  statements: 87,
  branches: 77,
  functions: 88,
  lines: 90,
};
