import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const api = 'http://127.0.0.1:5580';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5581, strictPort: true, proxy: { '/api': api, '/health': api, '/capabilities': api, '/runs': api } },
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true },
});
