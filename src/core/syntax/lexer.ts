import type { Span } from './ast.ts';
import { DiagnosticError } from '../diagnostics.ts';

export type TokenKind = 'ident' | 'int' | 'string' | 'punct' | 'keyword' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  value?: number | string;
  span: Span;
}

export const KEYWORDS = new Set([
  'model', 'title', 'description', 'const', 'type', 'var', 'process', 'action', 'when',
  'invariant', 'liveness', 'eventually', 'leadsto', 'terminal', 'fairness', 'weak', 'strong',
  'true', 'false', 'and', 'or', 'not', 'if', 'then', 'else', 'self', 'in', 'bool',
]);

// Longest first.
const PUNCT = ['..', ':=', '!=', '<=', '>=', '=>', '{', '}', '(', ')', ',', ';', ':', '=', '<', '>', '+', '-', '*', '%', '.'];

export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_TOKENS = 20000;
export const MAX_IDENT = 48;
export const MAX_STRING = 400;

export function lex(source: string): Token[] {
  if (typeof source !== 'string') throw new DiagnosticError('E001', 'Source must be text.', undefined);
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new DiagnosticError('E002', `Model source exceeds ${MAX_SOURCE_BYTES} bytes.`, undefined);
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;
  const advance = (k: number) => {
    for (let j = 0; j < k; j++) {
      if (source[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  };
  const spanFrom = (sl: number, sc: number, so: number): Span => ({ line: sl, col: sc, offset: so, end: i });

  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(1); continue; }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') advance(1);
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const sl = line, sc = col, so = i;
      advance(2);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) advance(1);
      if (i >= n) throw new DiagnosticError('E003', 'Unterminated block comment.', spanFrom(sl, sc, so));
      advance(2);
      continue;
    }
    const sl = line, sc = col, so = i;
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
      const text = source.slice(i, j);
      advance(j - i);
      if (text.length > MAX_IDENT) throw new DiagnosticError('E004', `Identifier '${text.slice(0, 20)}…' is longer than ${MAX_IDENT} characters.`, spanFrom(sl, sc, so));
      tokens.push({ kind: KEYWORDS.has(text) ? 'keyword' : 'ident', text, span: spanFrom(sl, sc, so) });
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(source[j])) j++;
      const text = source.slice(i, j);
      advance(j - i);
      if (text.length > 9) throw new DiagnosticError('E005', `Integer literal ${text.slice(0, 12)}… is too large (max 9 digits).`, spanFrom(sl, sc, so));
      tokens.push({ kind: 'int', text, value: Number(text), span: spanFrom(sl, sc, so) });
    } else if (c === '"') {
      advance(1);
      let out = '';
      while (i < n && source[i] !== '"') {
        if (source[i] === '\n') throw new DiagnosticError('E006', 'Unterminated string (strings cannot span lines).', spanFrom(sl, sc, so));
        if (source[i] === '\\' && (source[i + 1] === '"' || source[i + 1] === '\\')) { out += source[i + 1]; advance(2); continue; }
        out += source[i];
        advance(1);
      }
      if (i >= n) throw new DiagnosticError('E006', 'Unterminated string.', spanFrom(sl, sc, so));
      advance(1);
      if (out.length > MAX_STRING) throw new DiagnosticError('E007', `String longer than ${MAX_STRING} characters.`, spanFrom(sl, sc, so));
      tokens.push({ kind: 'string', text: out, value: out, span: spanFrom(sl, sc, so) });
    } else {
      const p = PUNCT.find((q) => source.startsWith(q, i));
      if (!p) throw new DiagnosticError('E008', `Unexpected character '${c}'.`, { line, col, offset: i, end: i + 1 });
      advance(p.length);
      tokens.push({ kind: 'punct', text: p, span: spanFrom(sl, sc, so) });
    }
    if (tokens.length > MAX_TOKENS) throw new DiagnosticError('E009', `Model has more than ${MAX_TOKENS} tokens.`, undefined);
  }
  tokens.push({ kind: 'eof', text: '<end of file>', span: { line, col, offset: i, end: i } });
  return tokens;
}
