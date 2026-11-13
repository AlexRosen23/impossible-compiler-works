// One Vite server for both wings of THE IMPOSSIBLE COMPILER WORKS: the Witness wing at `/` and the Compiler wing
// (formerly PAPER TIGER's IDE) at `/compiler/`. Loopback only, strict ports, no CORS.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_ANCESTORS } from '../wings/compiler/server/static.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const api = `http://127.0.0.1:${process.env.WITNESS_PORT ?? 5721}`;
const port = Number(process.env.WITNESS_WEB_PORT ?? 5720);

export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    cors: false,
    fs: { allow: [repo] },
    headers: { 'content-security-policy': `frame-ancestors ${FRAME_ANCESTORS.join(' ')}`, 'x-content-type-options': 'nosniff' },
    proxy: { '/api': api, '/health': api, '/capabilities': api, '/runs': api, '/engine': api },
  },
  preview: { host: '127.0.0.1', port, strictPort: true, cors: false },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { witness: path.join(here, 'index.html'), compiler: path.join(here, 'compiler', 'index.html') } },
  },
});
