import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('./apps/api/src', import.meta.url));
const backgroundSrcPath = fileURLToPath(new URL('./apps/background/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('./packages/backend-data/src', import.meta.url));
const backendErrorsSrcPath = fileURLToPath(new URL('./packages/backend-errors/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('./packages/backend-runtime/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('./packages/backend-services/src', import.meta.url));
const providerClientsSrcPath = fileURLToPath(new URL('./packages/provider-clients/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('./packages/shared/src', import.meta.url));
const cloudflareWorkersMockPath = fileURLToPath(new URL('test/mocks/cloudflare-workers.ts', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: [
        'apps/api/src/**/*.ts',
        'apps/background/src/**/*.ts',
        'packages/**/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts',
        '**/types.d.ts',
        '**/model/**',
      ],
      thresholds: {
        statements: 45,
        branches: 35,
        functions: 50,
        lines: 45,
      },
    },
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
    ],
  },
});
