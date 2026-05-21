import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('./apps/api/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('./packages/shared/src', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: [
      { find: '@/constants', replacement: `${apiSrcPath}/constants` },
      { find: '@/crypto', replacement: `${apiSrcPath}/crypto` },
      { find: '@/dao', replacement: `${apiSrcPath}/dao` },
      { find: '@/utils', replacement: `${apiSrcPath}/utils` },
      { find: '@caldav-bridge/shared', replacement: sharedSrcPath },
      { find: /^@\//, replacement: `${apiSrcPath}/` },
    ],
  },
});
