import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = `http://127.0.0.1:${process.env.WITNESS_PORT ?? 5721}`;

export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WITNESS_WEB_PORT ?? 5720),
    strictPort: true,
    proxy: { '/api': api, '/health': api, '/capabilities': api, '/runs': api },
  },
  preview: { host: '127.0.0.1', port: Number(process.env.WITNESS_WEB_PORT ?? 5720), strictPort: true },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
