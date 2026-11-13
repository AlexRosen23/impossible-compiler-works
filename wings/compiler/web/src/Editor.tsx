// CodeMirror 6 editor wired to the real FOLIO toolchain: highlighting comes from core/lexer token categories,
// squiggles from compiler diagnostics, completion from the checker's scopes, hovers from the type trace.
import { autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { type Diagnostic as CMDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorSelection, EditorState, RangeSet, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration, type DecorationSet, EditorView, GutterMarker, ViewPlugin, type ViewUpdate, WidgetType, gutter, highlightActiveLine,
  highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers,
} from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { BUILTIN_DOCS, type CheckResult, type Diagnostic, GROUP_SIG, KEYWORDS, PRIMITIVES, type Span, TYPE_NAMES, lex } from '../../core/index.ts';

export interface EditorHandle {
  setSource(s: string): void;
  getSource(): string;
  select(span: Span): void;
  setDebugLine(line: number | null): void;
  focus(): void;
}
interface Props {
  initial: string;
  onChange(src: string): void;
  diagnostics: Diagnostic[];
  check: CheckResult | null;
  breakpoints: Set<number>;
  onToggleBreakpoint(line: number): void;
  onCommand(cmd: 'compile' | 'save' | 'format'): void;
  readOnly?: boolean;
}

// --- highlighting from the real lexer ------------------------------------------------------------
class Swatch extends WidgetType {
  color: string;
  constructor(color: string) { super(); this.color = color; }
  eq(o: Swatch) { return o.color === this.color; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-swatch'; s.style.background = this.color.length === 9 ? this.color : this.color; s.setAttribute('aria-hidden', 'true'); return s; }
}
function tokenDecorations(view: EditorView): DecorationSet {
  const src = view.state.doc.toString();
  const { tokens } = lex(src);
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'eof' || t.span.end <= t.span.start) continue;
    const isCall = t.kind === 'ident' && tokens[i + 1]?.text === '(';
    const cls = isCall ? 'tk-call' : `tk-${t.kind}`;
    if (t.kind === 'color' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(t.text)) ranges.push(Decoration.widget({ widget: new Swatch(t.text), side: -1 }).range(t.span.start));
    ranges.push(Decoration.mark({ class: cls }).range(t.span.start, t.span.end));
  }
  return Decoration.set(ranges, true);
}
const lexHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = tokenDecorations(v); }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = tokenDecorations(u.view); }
}, { decorations: (v) => v.decorations });

// --- breakpoints and the debugger's current line --------------------------------------------------
const setBps = StateEffect.define<Set<number>>();
class BpMarker extends GutterMarker { toDOM() { const s = document.createElement('span'); s.className = 'cm-breakpoint'; s.textContent = '●'; return s; } }
const bpMarker = new BpMarker();
const bpField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(v, tr) { for (const e of tr.effects) if (e.is(setBps)) return e.value; return v; },
});
const setDebug = StateEffect.define<number | null>();
const debugField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDebug)) {
      if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) return Decoration.none;
      return Decoration.set([Decoration.line({ class: 'cm-debug-line' }).range(tr.state.doc.line(e.value).from)]);
    }
    return v.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const completion = (ctx: CompletionContext) => {
      const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
      if (!word && !ctx.explicit) return null;
      const pos = ctx.pos;
      const opts: Completion[] = [];
      for (const k of KEYWORDS) opts.push({ label: k, type: 'keyword' });
      for (const t of TYPE_NAMES) opts.push({ label: t, type: 'type' });
      for (const [n, d] of Object.entries(BUILTIN_DOCS)) opts.push({ label: n, type: 'function', detail: d.split(' — ')[0].replace(/^\w+/, ''), info: d });
      for (const [n, p] of Object.entries(PRIMITIVES)) opts.push({ label: n, type: 'method', info: p.doc, apply: `${n}(${p.params.filter((x) => x.default === undefined).map((x) => `${x.name}: `).join(', ')})` });
      opts.push({ label: 'group', type: 'method', info: GROUP_SIG.doc });
      for (const w of ['size', 'frames', 'background', 'from']) opts.push({ label: w, type: 'keyword', detail: 'contextual' });
      // Names in scope at the cursor, from the last successful check (lexical scopes by span).
      const c = latest.current.check;
      if (c) {
        const inScope = new Set(c.scopes.filter((s) => s.kind === 'global' || (s.span.start <= pos && pos <= s.span.end)).map((s) => s.id));
        for (const s of c.symbols) {
          if (!inScope.has(s.scopeId)) continue;
          if ((s.kind === 'let' || s.kind === 'var') && s.declSpan.start > pos) continue;
          opts.push({ label: s.name, type: s.kind === 'fn' ? 'function' : 'variable', detail: `${s.kind} · ${s.type}`, boost: 2 });
        }
      }
      return { from: word ? word.from : pos, options: opts, validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ };
    };
    const hover = hoverTooltip((v, pos) => {
      const c = latest.current.check;
      const word = v.state.wordAt(pos);
      const text = word ? v.state.sliceDoc(word.from, word.to) : '';
      let html = '';
      if (text && BUILTIN_DOCS[text]) html = BUILTIN_DOCS[text];
      else if (text && PRIMITIVES[text]) html = PRIMITIVES[text].doc;
      else if (text === 'group') html = GROUP_SIG.doc;
      else if (c) {
        let best: CheckResult['trace'][number] | null = null;
        for (const t of c.trace) if (t.span.start <= pos && pos < t.span.end && (!best || t.span.end - t.span.start < best.span.end - best.span.start)) best = t;
        if (best) html = `${v.state.sliceDoc(best.span.start, best.span.end).slice(0, 60)} : ${best.type}\n${best.rule}`;
      }
      if (!html) return null;
      return { pos, above: true, create: () => { const d = document.createElement('div'); d.style.padding = '6px 8px'; d.style.whiteSpace = 'pre-wrap'; d.style.maxWidth = '420px'; d.textContent = html; return { dom: d }; } };
    });
    const bpGutter = gutter({
      class: 'cm-bp-gutter',
      markers: (v) => { const set = v.state.field(bpField); const ms = []; for (const l of [...set].sort((a, b) => a - b)) if (l <= v.state.doc.lines) ms.push(bpMarker.range(v.state.doc.line(l).from)); return RangeSet.of(ms); },
      initialSpacer: () => bpMarker,
      domEventHandlers: { mousedown(v, line) { latest.current.onToggleBreakpoint(v.state.doc.lineAt(line.from).number); return true; } },
    });
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          bpField, debugField, bpGutter, lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), history(), indentOnInput(), bracketMatching(),
          lintGutter(), lexHighlight, autocompletion({ override: [completion] }), hover,
          EditorState.readOnly.of(!!props.readOnly), EditorState.tabSize.of(2),
          keymap.of([
            { key: 'Mod-Enter', run: () => { latest.current.onCommand('compile'); return true; } },
            { key: 'Mod-s', run: () => { latest.current.onCommand('save'); return true; }, preventDefault: true },
            { key: 'Shift-Alt-f', run: () => { latest.current.onCommand('format'); return true; } },
            indentWithTab, ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) latest.current.onChange(u.state.doc.toString()); }),
          EditorView.contentAttributes.of({ 'aria-label': 'FOLIO source editor' }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    const ds: CMDiagnostic[] = props.diagnostics.filter((d) => d.code !== 'ICE').map((d) => ({
      from: Math.min(d.span.start, len), to: Math.min(Math.max(d.span.end, d.span.start + 1), len), severity: d.severity,
      message: `${d.code} ${d.message}${d.hint ? `\nhint: ${d.hint}` : ''}`,
    }));
    v.dispatch(setDiagnostics(v.state, ds));
  }, [props.diagnostics]);

  useEffect(() => { view.current?.dispatch({ effects: setBps.of(new Set(props.breakpoints)) }); }, [props.breakpoints]);

  useImperativeHandle(ref, () => ({
    setSource(s: string) { const v = view.current!; if (v.state.doc.toString() !== s) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: s } }); },
    getSource() { return view.current!.state.doc.toString(); },
    select(span: Span) {
      const v = view.current!;
      const len = v.state.doc.length;
      v.dispatch({ selection: EditorSelection.range(Math.min(span.start, len), Math.min(Math.max(span.end, span.start), len)), effects: EditorView.scrollIntoView(Math.min(span.start, len), { y: 'center' }) });
      v.focus();
    },
    setDebugLine(line: number | null) {
      const v = view.current!;
      const effects: StateEffect<unknown>[] = [setDebug.of(line)];
      if (line && line <= v.state.doc.lines) effects.push(EditorView.scrollIntoView(v.state.doc.line(line).from, { y: 'nearest' }));
      v.dispatch({ effects });
    },
    focus() { view.current?.focus(); },
  }), []);

  return <div className="editor-wrap" ref={host} />;
});
