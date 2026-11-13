import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { api } from '../api';
import type { Diagnostic } from '../types';

const KW = new Set(['model', 'title', 'description', 'const', 'type', 'var', 'process', 'action', 'when', 'invariant', 'liveness', 'eventually', 'leadsto', 'terminal', 'fairness', 'weak', 'strong', 'in', 'bool']);
const OPS = new Set(['and', 'or', 'not', 'if', 'then', 'else']);

const wml = StreamLanguage.define<{ inComment: boolean }>({
  startState: () => ({ inComment: false }),
  token(stream, st) {
    if (st.inComment) {
      if (stream.skipTo('*/')) { stream.next(); stream.next(); st.inComment = false; } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { st.inComment = true; return 'comment'; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^(true|false|self)\b/)) return 'atom';
    const w = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/) as RegExpMatchArray | null;
    if (w) {
      if (KW.has(w[0])) return 'keyword';
      if (OPS.has(w[0])) return 'operator';
      return 'variableName';
    }
    if (stream.match(/^(:=|=>|!=|<=|>=|\.\.)/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
});

const style = HighlightStyle.define([
  { tag: t.keyword, color: '#9C9BDC' },
  { tag: t.operator, color: '#C4A66E' },
  { tag: t.comment, color: '#6f6b80', fontStyle: 'italic' },
  { tag: t.string, color: '#80B9A1' },
  { tag: t.number, color: '#e0b98a' },
  { tag: t.atom, color: '#e0b98a' },
  { tag: t.variableName, color: '#F0ECE4' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#F0ECE4', fontSize: '12.5px', height: '100%' },
  '.cm-content': { fontFamily: 'SF Mono, ui-monospace, Menlo, monospace', caretColor: '#C4A66E' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#5d596e', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(156,155,220,0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#9C9BDC' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(156,155,220,0.25) !important' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-tooltip': { backgroundColor: '#20202E', border: '1px solid #34344A', color: '#F0ECE4' },
  '.cm-diagnostic-error': { borderLeft: '3px solid #D07878' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid #C4A66E' },
}, { dark: true });

interface Props {
  value: string;
  onChange: (v: string) => void;
  onDiagnostics: (d: Diagnostic[]) => void;
  label: string;
}

export function Editor({ value, onChange, onDiagnostics, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onDiagnostics });
  cb.current = { onChange, onDiagnostics };

  useEffect(() => {
    const lint = linter(async (v) => {
      const src = v.state.doc.toString();
      try {
        const r = await api.compile(src);
        cb.current.onDiagnostics(r.diagnostics);
        return r.diagnostics.map((d): CmDiagnostic => {
          const from = Math.min(d.span?.offset ?? 0, src.length);
          const to = Math.min(Math.max(d.span?.end ?? from + 1, from + 1), src.length);
          return { from, to: Math.max(from, to), severity: d.severity, message: `${d.code}: ${d.message}` };
        });
      } catch {
        return [];
      }
    }, { delay: 350 });
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), bracketMatching(), lintGutter(), lint,
          wml, syntaxHighlighting(style), theme, keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
          EditorView.contentAttributes.of({ 'aria-label': label }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external value changes (loading another model / revision)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div className="cm-host" ref={host} data-testid="model-editor" />;
}
