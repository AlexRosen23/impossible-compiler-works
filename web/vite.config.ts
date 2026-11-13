import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { FRAME_ANCESTORS } from '../server/static.ts';

const api = 'http://127.0.0.1:5580';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Dev server: no CORS for anyone (Vite's default would let any localhost page read the proxied API), and the
  // same framing rule as the built IDE (server/static.ts).
  server: {
    host: '127.0.0.1', port: 5581, strictPort: true, cors: false,
    headers: { 'content-security-policy': `frame-ancestors ${FRAME_ANCESTORS.join(' ')}`, 'x-content-type-options': 'nosniff' },
    proxy: { '/api': api, '/health': api, '/capabilities': api, '/runs': api },
  },
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true },
});
