import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { COMPILER_VERSION, type Diagnostic, GRAMMAR_VERSION, type PassName, SAFE_PASSES, type Span, compile, formatProgram, parse } from '../../core/index.ts';
import { Editor, type EditorHandle } from './Editor.tsx';
import { Cabinet } from './modes/Cabinet.tsx';
import { Duel } from './modes/Duel.tsx';
import { Editorial } from './modes/Editorial.tsx';
import { Furnace } from './modes/Furnace.tsx';
import { Gallery } from './modes/Gallery.tsx';
import { Lowering } from './modes/Lowering.tsx';
import { Observatory } from './modes/Observatory.tsx';
import { Theater } from './modes/Theater.tsx';
import { Tour } from './Tour.tsx';
import { EXAMPLES, FIXTURES, MODES, type Mode, type Route, WB, type Workbench, api, lineDiff, parseRoute, routeHash } from './workbench.ts';

interface Project { id: string; name: string; head: { id: string; seq: number; source: string }; versions: { id: string; seq: number; message: string; created_at: string }[]; forkedFrom: string | null }

const store = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable: drafts are a convenience only */ } } };

export function App() {
  const initialRoute = useMemo(() => parseRoute(location.hash), []);
  const firstExample = EXAMPLES.find((e) => e.id === initialRoute.example) ?? EXAMPLES[0];
  const [route, setRoute] = useState<Route>(initialRoute.project ? initialRoute : { ...initialRoute, example: firstExample.id });
  const [source, setSourceState] = useState(firstExample.source);
  const [label, setLabel] = useState(firstExample.title);
  const [passes, setPasses] = useState<PassName[]>(SAFE_PASSES);
  const [frame, setFrame] = useState(0);
  const [breakpoints, setBreakpoints] = useState<Set<number>>(new Set());
  const [toastMsg, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'history' } | { kind: 'conflict'; head: { id: string; seq: number; source: string } }>(null);
  const [tour, setTour] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const deferred = useDeferredValue(source);
  const compiled = useMemo(() => compile(deferred, { passes, fixtures: FIXTURES }), [deferred, passes]);

  const toast = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 3200); }, []);
  const setSource = useCallback((s: string) => { setSourceState(s); editor.current?.setSource(s); }, []);
  const load = useCallback((s: string, l: string) => { setSource(s); setLabel(l); setFrame(0); setBreakpoints(new Set()); }, [setSource]);
  const go = useCallback((r: Route) => { setRoute(r); history.replaceState(null, '', routeHash(r)); }, []);
  const setMode = useCallback((m: Mode) => go({ ...route, mode: m }), [go, route]);

  useEffect(() => { api<{ ok: boolean }>('/health').then((r) => setOnline(r.status === 200)).catch(() => setOnline(false)); }, []);
  useEffect(() => { history.replaceState(null, '', routeHash(route)); }, []);
  // Open a saved project by id (deep link or hash change). parseRoute only passes server-shaped ids.
  const projectId = useRef<string | null>(null);
  const openProject = useCallback((id: string) => {
    if (projectId.current === id) return;
    projectId.current = id;
    api<Project>(`/api/projects/${encodeURIComponent(id)}`).then((r) => {
      if (r.status !== 200) { projectId.current = null; toast('that project was not found'); return; }
      setProject(r.data);
      const draft = store.get(`pt:draft:${r.data.id}:${r.data.head.id}`);
      load(draft ?? r.data.head.source, r.data.name);
      if (draft && draft !== r.data.head.source) toast('restored an unsaved local draft');
    }).catch(() => { projectId.current = null; toast('server offline: cannot open the project'); });
  }, [load]);
  useEffect(() => {
    const onHash = () => {
      const r = parseRoute(location.hash);
      setRoute((cur) => ({ ...cur, ...r }));
      if (r.example) { const ex = EXAMPLES.find((e) => e.id === r.example); if (ex) load(ex.source, ex.title); }
      if (r.project) openProject(r.project);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [load, openProject]);
  // Deep link to a saved project.
  useEffect(() => { if (initialRoute.project) openProject(initialRoute.project); }, []);
  useEffect(() => { if (project) projectId.current = project.id; }, [project]);
  // Local draft autosave (per project head): a convenience; the server copy is the record.
  useEffect(() => { if (project) store.set(`pt:draft:${project.id}:${project.head.id}`, source); }, [source, project]);

  const save = useCallback(async (force = false) => {
    if (!online) { toast('server offline: saving needs the API on 127.0.0.1:5721'); return; }
    const src = editor.current?.getSource() ?? source;
    if (!project) {
      const r = await api<Project>('/api/projects', { method: 'POST', body: { name: label || 'untitled', source: src } });
      if (r.status === 201) { setProject(r.data); go({ mode: route.mode, project: r.data.id }); toast(`saved as new project · v1`); }
      return;
    }
    const base = force && dialog?.kind === 'conflict' ? dialog.head.id : project.head.id;
    const r = await api<Project & { error?: string; head: Project['head']; unchanged?: boolean }>(`/api/projects/${project.id}/versions`, { method: 'POST', body: { baseVersion: base, source: src, message: 'saved from the IDE' } });
    if (r.status === 409) { setDialog({ kind: 'conflict', head: r.data.head }); return; }
    if (r.status >= 400) { toast(`save failed: ${r.data.error}`); return; }
    setProject(r.data);
    setDialog(null);
    toast(r.data.unchanged ? 'no changes to save' : `saved · v${r.data.head.seq}`);
  }, [online, source, project, label, go, route.mode, toast, dialog]);

  const fork = useCallback(async () => {
    if (!project) { toast('save the project first, then fork it'); return; }
    const r = await api<Project>(`/api/projects/${project.id}/fork`, { method: 'POST', body: {} });
    if (r.status === 201) { setProject(r.data); setLabel(r.data.name); go({ mode: route.mode, project: r.data.id }); toast(`forked into ${r.data.name}`); }
  }, [project, go, route.mode, toast]);

  const format = useCallback(() => {
    const p = parse(source);
    if (!p.program || p.diagnostics.some((d) => d.severity === 'error')) { toast('fix the syntax errors before formatting'); return; }
    if (p.tokens.some((t) => t.kind === 'comment')) { toast('Format would drop comments (FOLIO 0.1 formatter limitation), so it is refused for files with comments'); return; }
    setSource(formatProgram(p.program));
    toast('formatted');
  }, [source, setSource, toast]);

  const toggleBp = useCallback((line: number) => setBreakpoints((s) => { const n = new Set(s); if (n.has(line)) n.delete(line); else n.add(line); return n; }), []);
  const wb: Workbench = {
    source, setSource, passes, setPasses, compiled, frame, setFrame, breakpoints, load, toast, label, online, setMode,
    select: (span: Span) => editor.current?.select(span),
    setDebugLine: (l: number | null) => editor.current?.setDebugLine(l),
  };
  useEffect(() => { if (route.mode !== 'theater') editor.current?.setDebugLine(null); }, [route.mode]);

  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  const warnings = compiled.diagnostics.filter((d) => d.severity === 'warning');
  const status = compiled.ok ? <span className="chip ok">● compiled · {compiled.stages.reduce((a, s) => a + s.ms, 0).toFixed(1)} ms</span>
    : <span className="chip bad">● {errors.length} error{errors.length === 1 ? '' : 's'} in {compiled.stages.find((s) => !s.ok)?.stage}</span>;

  return (
    <WB.Provider value={wb}>
      <div className="app">
        <header className="masthead">
          <div className="wordmark">PAPER <b>TIGER</b> COMPILER WORKS<small>FOLIO {GRAMMAR_VERSION.split('/')[1]} · compiler {COMPILER_VERSION} · a language laboratory</small></div>
          <select className="btn" aria-label="Load an example program" value="" onChange={(e) => { const ex = EXAMPLES.find((x) => x.id === e.target.value); if (ex) { load(ex.source, ex.title); setProject(null); go({ mode: route.mode, example: ex.id }); } }}>
            <option value="">Examples ({EXAMPLES.length})…</option>
            {EXAMPLES.map((e) => <option key={e.id} value={e.id}>{e.id.slice(0, 2)} · {e.title}</option>)}
          </select>
          {status}
          {warnings.length > 0 && <span className="chip warn">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
          <span className="spacer" />
          <span className={`chip desk-only ${online ? 'ok' : 'warn'}`} title="API server on 127.0.0.1:5721 (/engine/compiler)">{online ? 'server ● loopback' : 'server offline · local only'}</span>
          <button className="btn" onClick={() => setTour(true)}>90-second tour</button>
        </header>
        <nav className="modes" role="tablist" aria-label="Workshop modes">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={route.mode === m.id} onClick={() => setMode(m.id)}><span className="num">{m.key}</span>{m.label}</button>
          ))}
        </nav>
        <main className={`workspace ${route.mode === 'editorial' ? 'editorial' : ''}`}>
          <section className="pane" aria-label="Source">
            <div className="projectbar">
              <input aria-label="Project name" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button className="btn" onClick={() => save()} title="Save a new version (⌘S)">Save<kbd>⌘S</kbd></button>
              <button className="btn" onClick={() => (project ? setDialog({ kind: 'history' }) : toast('save first to start a history'))}>History{project ? ` · v${project.head.seq}` : ''}</button>
              <button className="btn" onClick={fork}>Fork</button>
              <button className="btn ghost" onClick={format} title="Format (⇧⌥F)">Format</button>
            </div>
            <Editor ref={editor} initial={source} onChange={setSourceState} diagnostics={compiled.diagnostics} check={compiled.check} breakpoints={breakpoints} onToggleBreakpoint={toggleBp}
              onCommand={(c) => (c === 'save' ? save() : c === 'format' ? format() : toast(compiled.ok ? 'compiled (the IDE compiles as you type)' : 'see the diagnostics below'))} />
            <div className="pane-foot">
              <div className="pane-head"><h2>Diagnostics</h2><span>{errors.length} errors · {warnings.length} warnings</span></div>
              <Diagnostics list={compiled.diagnostics} onPick={(d) => editor.current?.select(d.span)} />
            </div>
          </section>
          {route.mode === 'editorial' && <Editorial />}
          {route.mode === 'furnace' && <Furnace />}
          {route.mode === 'observatory' && <Observatory />}
          {route.mode === 'lowering' && <Lowering />}
          {route.mode === 'duel' && <Duel />}
          {route.mode === 'theater' && <Theater />}
          {route.mode === 'gallery' && <Gallery />}
          {route.mode === 'cabinet' && <Cabinet project={project} />}
        </main>
        {tour && <Tour onClose={() => setTour(false)} />}
        {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
        {dialog?.kind === 'history' && project && <HistoryDialog project={project} current={source} onClose={() => setDialog(null)}
          onRestore={async (seq) => { const r = await api<Project>(`/api/projects/${project.id}/restore`, { method: 'POST', body: { seq } }); if (r.status === 201) { setProject(r.data); load(r.data.head.source, r.data.name); setDialog(null); toast(`restored v${seq} as v${r.data.head.seq}`); } }} />}
        {dialog?.kind === 'conflict' && (
          <div className="dialog-back" role="dialog" aria-modal="true" aria-label="Save conflict">
            <div className="dialog">
              <div className="pane-head"><h2>Save conflict</h2><span>this project was saved elsewhere (latest v{dialog.head.seq})</span></div>
              <p className="lede" style={{ marginTop: 12 }}>Your edits started from v{project?.head.seq}. Nothing was overwritten. Compare, then choose.</p>
              <div className="diff">{lineDiff(dialog.head.source, source).map((d, i) => <div key={i} className={d.t === '+' ? 'add' : d.t === '-' ? 'del' : ''}>{d.t} {d.s}</div>)}</div>
              <div className="toolbar">
                <button className="btn primary" onClick={() => save(true)}>Keep mine (save on top of v{dialog.head.seq})</button>
                <button className="btn" onClick={() => { load(dialog.head.source, label); setProject((p) => (p ? { ...p, head: dialog.head } : p)); setDialog(null); }}>Take theirs</button>
                <button className="btn ghost" onClick={() => setDialog(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </WB.Provider>
  );
}

function Diagnostics({ list, onPick }: { list: Diagnostic[]; onPick(d: Diagnostic): void }) {
  if (!list.length) return <div className="diags"><div className="empty">No diagnostics. Parser and checker both accept this program.</div></div>;
  return (
    <div className="diags" role="list">
      {list.map((d, i) => (
        <button key={i} role="listitem" className={`diag ${d.severity}`} onClick={() => onPick(d)}>
          <span className="code">{d.code}</span>
          <span><span className="msg">{d.message}</span> <span className="where">· {d.stage} · {d.span.line}:{d.span.col}</span></span>
          {d.hint && <span className="hint">↳ {d.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function HistoryDialog({ project, current, onClose, onRestore }: { project: Project; current: string; onClose(): void; onRestore(seq: number): void }) {
  const [diffWith, setDiffWith] = useState<{ seq: number; source: string } | null>(null);
  return (
    <div className="dialog-back" role="dialog" aria-modal="true" aria-label="Version history" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <div className="pane-head"><h2>History · {project.name}</h2><span className="spacer" /><button className="btn ghost" onClick={onClose}>Close</button></div>
        <table className="grid"><thead><tr><th>Version</th><th>Saved</th><th>Note</th><th /></tr></thead><tbody>
          {project.versions.map((v) => (
            <tr key={v.id}><td>v{v.seq}{v.seq === project.head.seq ? ' (latest)' : ''}</td><td>{new Date(v.created_at).toLocaleString()}</td><td>{v.message}</td>
              <td><button className="btn" onClick={async () => { const r = await api<{ source: string }>(`/api/projects/${project.id}/versions/${v.seq}`); setDiffWith({ seq: v.seq, source: r.data.source }); }}>Diff vs editor</button>{' '}
                {v.seq !== project.head.seq && <button className="btn" onClick={() => onRestore(v.seq)}>Restore</button>}</td></tr>
          ))}
        </tbody></table>
        {diffWith && <><div className="subhead">v{diffWith.seq} → editor</div><div className="diff">{lineDiff(diffWith.source, current).map((d, i) => <div key={i} className={d.t === '+' ? 'add' : d.t === '-' ? 'del' : ''}>{d.t} {d.s}</div>)}</div></>}
      </div>
    </div>
  );
}
