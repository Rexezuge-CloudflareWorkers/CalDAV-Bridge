import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  { ignores: ['app/dist/**', 'apps/web/dist/**', 'src/generated/**', 'apps/api/src/generated/**'] },
  { files: ['**/*.js'], languageOptions: { sourceType: 'script' } },
  { files: ['**/*.{js,mjs,cjs,ts,mts,cts}'], languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  // --- Import direction guardrails ---
  // Layer 0: shared — zero @caldav-bridge/* deps
  {
    files: ['packages/shared/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/*'], message: 'shared must not import from other @caldav-bridge packages — it is a zero-dependency base layer' },
        ],
      }],
    },
  },
  // Layer 0: backend-errors — zero @caldav-bridge/* deps
  {
    files: ['packages/backend-errors/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/*'], message: 'backend-errors must not import from other @caldav-bridge packages — it is a zero-dependency base layer' },
        ],
      }],
    },
  },
  // Layer 1: backend-runtime — only shared and backend-errors
  {
    files: ['packages/backend-runtime/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/backend-data', '@caldav-bridge/backend-data/*'], message: 'backend-runtime must not import from backend-data (higher layer)' },
          { group: ['@caldav-bridge/provider-clients', '@caldav-bridge/provider-clients/*'], message: 'backend-runtime must not import from provider-clients (higher layer)' },
          { group: ['@caldav-bridge/backend-services', '@caldav-bridge/backend-services/*'], message: 'backend-runtime must not import from backend-services (higher layer)' },
          { group: ['@caldav-bridge/api', '@caldav-bridge/api/*'], message: 'backend-runtime must not import from apps/api' },
          { group: ['@caldav-bridge/background', '@caldav-bridge/background/*'], message: 'backend-runtime must not import from apps/background' },
        ],
      }],
    },
  },
  // Layer 2: backend-data — only shared and backend-errors
  {
    files: ['packages/backend-data/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/backend-runtime', '@caldav-bridge/backend-runtime/*'], message: 'backend-data must not import from backend-runtime' },
          { group: ['@caldav-bridge/provider-clients', '@caldav-bridge/provider-clients/*'], message: 'backend-data must not import from provider-clients' },
          { group: ['@caldav-bridge/backend-services', '@caldav-bridge/backend-services/*'], message: 'backend-data must not import services (higher layer)' },
          { group: ['@caldav-bridge/api', '@caldav-bridge/api/*'], message: 'backend-data must not import from apps/api' },
          { group: ['@caldav-bridge/background', '@caldav-bridge/background/*'], message: 'backend-data must not import from apps/background' },
        ],
      }],
    },
  },
  // Layer 2: provider-clients — only shared and backend-errors
  {
    files: ['packages/provider-clients/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/backend-data', '@caldav-bridge/backend-data/*'], message: 'provider-clients must not import DAOs from backend-data' },
          { group: ['@caldav-bridge/backend-runtime', '@caldav-bridge/backend-runtime/*'], message: 'provider-clients must not import from backend-runtime' },
          { group: ['@caldav-bridge/backend-services', '@caldav-bridge/backend-services/*'], message: 'provider-clients must not import from backend-services (higher layer)' },
          { group: ['@caldav-bridge/api', '@caldav-bridge/api/*'], message: 'provider-clients must not import from apps/api' },
          { group: ['@caldav-bridge/background', '@caldav-bridge/background/*'], message: 'provider-clients must not import from apps/background' },
        ],
      }],
    },
  },
  // Layer 3: backend-services — cannot import apps
  {
    files: ['packages/backend-services/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/api', '@caldav-bridge/api/*'], message: 'backend-services must not import from apps/api' },
          { group: ['@caldav-bridge/background', '@caldav-bridge/background/*'], message: 'backend-services must not import from apps/background' },
        ],
      }],
    },
  },
  // Layer 5: apps/api — route through backend-services, not directly to provider-clients
  {
    files: ['apps/api/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@caldav-bridge/provider-clients', '@caldav-bridge/provider-clients/*'], message: 'apps/api must not import provider-clients directly; use @caldav-bridge/backend-services instead' },
        ],
      }],
    },
  },
]);
