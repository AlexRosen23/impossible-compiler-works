import { useEffect, useState } from 'react';
import { Bazaar, NewModel } from './components/Bazaar';
import { Workspace } from './components/Workspace';

function useHash() {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => { const f = () => setH(location.hash || '#/'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h;
}

export function App() {
  const hash = useHash();
  const [health, setHealth] = useState<'ok' | 'down' | '…'>('…');
  useEffect(() => { void fetch('/health').then((r) => setHealth(r.ok ? 'ok' : 'down')).catch(() => setHealth('down')); }, []);
  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query ?? '');
  const m = /^\/model\/([a-z0-9-]+)$/.exec(path);
  let page;
  if (path === '/journey') page = <Workspace key="journey" initialSlug="inventory-race" journey />;
  else if (m) page = <Workspace key={`${m[1]}:${params.get('run') ?? ''}`} initialSlug={m[1]} runId={params.get('run') ?? undefined} />;
  else if (path === '/new') page = <NewModel />;
  else page = <Bazaar />;
  useEffect(() => { document.title = m ? `${m[1]} — The Impossible Witness` : path === '/journey' ? 'Journey — The Impossible Witness' : 'The Impossible Witness'; }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="shell">
      <a href="#main" className="sr-only">Skip to content</a>
      <header className="topbar">
        <a className="wordmark" href="#/">THE <b>IMPOSSIBLE</b> WITNESS</a>
        <nav className="topnav" aria-label="Primary">
          <a href="#/" aria-current={path === '/' || path === '' ? 'page' : undefined}>Model Bazaar</a>
          <a href="#/journey" aria-current={path === '/journey' ? 'page' : undefined}>90-second journey</a>
          <a href="#/new" aria-current={path === '/new' ? 'page' : undefined}>Write a model</a>
        </nav>
        <span className="spacer" />
        <span className={`pill ${health === 'ok' ? 'ok' : health === 'down' ? 'bad' : ''}`} title="checker service on 127.0.0.1">{health === 'ok' ? 'checker online · local only' : health === 'down' ? 'checker offline' : 'connecting…'}</span>
      </header>
      {page}
    </div>
  );
}
