import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineWebViteConfig, spaShellEmbedPlugin } from '@rexezuge/tooling/vite';

export default defineWebViteConfig({
  plugins: [react(), tailwindcss(), spaShellEmbedPlugin({ path: '../../apps/api/src/generated/spa-shell.ts' })],
  proxy: {
    '/api': {
      target: 'http://localhost:8787',
      changeOrigin: true,
    },
  },
});
