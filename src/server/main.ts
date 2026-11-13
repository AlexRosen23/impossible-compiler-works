// Entry point: node src/server/main.ts   (env: WITNESS_PORT, WITNESS_DB, WITNESS_STATIC)
import path from 'node:path';
import { createApp, ROOT, SERVICE, VERSION } from './app.ts';

const port = Number(process.env.WITNESS_PORT ?? 5721);
const dbFile = process.env.WITNESS_DB ?? path.join(ROOT, 'data', 'witness.db');
const staticDir = process.env.WITNESS_STATIC ?? path.join(ROOT, 'web', 'dist');
const app = createApp({ dbFile, staticDir, concurrency: Number(process.env.WITNESS_CONCURRENCY ?? 1) });
app.server.listen(port, '127.0.0.1', () => {
  console.log(`${SERVICE} ${VERSION} listening on http://127.0.0.1:${port} (db ${path.relative(ROOT, dbFile)})`);
});
const stop = () => { void app.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
