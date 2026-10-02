import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/ollama': {
        target: 'http://127.0.0.1:11434',
        rewrite: (path) => path.replace(/^\/api\/ollama/, '/api'),
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
