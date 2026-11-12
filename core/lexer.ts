// FOLIO lexer: source text → tokens with spans. Comments are kept as trivia tokens (the IDE colours them; the
// parser skips them). Never throws: problems become L-coded diagnostics and an `error` token.
import type { Diagnostic, Span } from './diagnostics.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';

export type TokenKind =
  | 'number' | 'string' | 'color' | 'ident' | 'keyword' | 'type' | 'punct' | 'comment' | 'error' | 'eof';

export interface Token {
  kind: TokenKind;
  /** The token text as written (for strings: the raw text including quotes). */
  text: string;
  /** Decoded value for number / string / color literals. */
  value?: number | string;
  span: Span;
}

export const KEYWORDS = new Set([
  'scene', 'fn', 'let', 'var', 'if', 'else', 'repeat', 'in', 'return', 'assert', 'true', 'false',
  'and', 'or', 'not', 'data', 'group',
]);
/** Contextual words: ordinary names everywhere except in a scene header (size, frames, background) and a data
 * declaration (from). They stay usable as argument and variable names. */
export const CONTEXTUAL = new Set(['size', 'frames', 'background', 'from']);
export const TYPE_NAMES = new Set(['Number', 'Boolean', 'String', 'Color', 'Point', 'List']);

const PUNCT = ['..', '->', '==', '!=', '<=', '>=', '{', '}', '(', ')', '[', ']', ',', ':', ';', '.', '=', '<', '>', '+', '-', '*', '/', '%'];

export interface LexResult { tokens: Token[]; diagnostics: Diagnostic[] }

export function lex(src: string, limits: Limits = DEFAULT_LIMITS): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const err = (code: string, message: string, span: Span) => diagnostics.push({ code, severity: 'error', message, span, stage: 'lex' });
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src.charCodeAt(i) === 10) { line++; col = 1; } else col++;
      i++;
    }
  };
  if (src.length > limits.maxSourceChars) {
    err('S001', `source is ${src.length} characters; the limit is ${limits.maxSourceChars}`, { start: 0, end: 0, line: 1, col: 1 });
    return { tokens: [{ kind: 'eof', text: '', span: { start: 0, end: 0, line: 1, col: 1 } }], diagnostics };
  }
  while (i < src.length) {
    if (tokens.length > limits.maxTokens) {
      err('S001', `more than ${limits.maxTokens} tokens`, { start: i, end: i, line, col });
      break;
    }
    const c = src[i];
    const start = i, sl = line, sc = col;
    const mk = (kind: TokenKind, value?: number | string): Token => ({ kind, text: src.slice(start, i), value, span: { start, end: i, line: sl, col: sc } });
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(1); continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance(1);
      tokens.push(mk('comment'));
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      advance(2);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance(1);
      if (i >= src.length) { err('L005', 'block comment is never closed with */', { start, end: i, line: sl, col: sc }); tokens.push(mk('comment')); break; }
      advance(2);
      tokens.push(mk('comment'));
      continue;
    }
    if (isDigit(c)) {
      while (isDigit(src[i])) advance(1);
      if (src[i] === '.' && isDigit(src[i + 1])) { advance(1); while (isDigit(src[i])) advance(1); }
      if (isIdentStart(src[i])) {
        while (isIdentPart(src[i])) advance(1);
        err('L007', `"${src.slice(start, i)}" is not a valid number`, { start, end: i, line: sl, col: sc });
        tokens.push(mk('error'));
        continue;
      }
      const v = Number(src.slice(start, i));
      if (!Number.isFinite(v)) { err('L007', 'number literal is too large', { start, end: i, line: sl, col: sc }); tokens.push(mk('error')); continue; }
      tokens.push(mk('number', v));
      continue;
    }
    if (isIdentStart(c)) {
      while (isIdentPart(src[i])) advance(1);
      const t = src.slice(start, i);
      tokens.push(mk(KEYWORDS.has(t) ? 'keyword' : TYPE_NAMES.has(t) ? 'type' : 'ident'));
      continue;
    }
    if (c === '"') {
      advance(1);
      let out = '';
      let ok = true;
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\') {
          const e = src[i + 1];
          const escStart = i, el = line, ec = col;
          if (e === 'n') { out += '\n'; advance(2); }
          else if (e === 't') { out += '\t'; advance(2); }
          else if (e === '"') { out += '"'; advance(2); }
          else if (e === '\\') { out += '\\'; advance(2); }
          else if (e === 'u' && src[i + 2] === '{') {
            const close = src.indexOf('}', i + 3);
            const hex = close > 0 ? src.slice(i + 3, close) : '';
            const cp = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : -1;
            if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
              err('L003', 'invalid \\u{...} escape (needs 1–6 hex digits naming a Unicode scalar value)', { start: escStart, end: Math.max(close + 1, i + 2), line: el, col: ec });
              ok = false;
              advance(close > 0 ? close + 1 - i : 2);
            } else { out += String.fromCodePoint(cp); advance(close + 1 - i); }
          } else {
            err('L003', `unknown escape \\${e ?? ''}`, { start: escStart, end: i + 2, line: el, col: ec });
            ok = false;
            advance(Math.min(2, src.length - i));
          }
        } else { out += src[i]; advance(1); }
      }
      if (src[i] !== '"') {
        err('L002', 'string is never closed with "', { start, end: i, line: sl, col: sc });
        tokens.push(mk('error'));
        continue;
      }
      advance(1);
      if (out.length > limits.maxStringLength) { err('L006', `string literal has ${out.length} characters; the limit is ${limits.maxStringLength}`, { start, end: i, line: sl, col: sc }); ok = false; }
      tokens.push(ok ? mk('string', out) : mk('error'));
      continue;
    }
    if (c === '#') {
      advance(1);
      while (isIdentPart(src[i])) advance(1);
      const hex = src.slice(start + 1, i);
      if (/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) tokens.push(mk('color', '#' + hex.toLowerCase()));
      else { err('L004', `"${src.slice(start, i)}" is not a colour: write #RRGGBB or #RRGGBBAA`, { start, end: i, line: sl, col: sc }); tokens.push(mk('error')); }
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (p) { advance(p.length); tokens.push(mk('punct')); continue; }
    advance(c.codePointAt(0)! > 0xffff ? 2 : 1);
    err('L001', `unexpected character "${src.slice(start, i)}"`, { start, end: i, line: sl, col: sc });
    tokens.push(mk('error'));
  }
  tokens.push({ kind: 'eof', text: '', span: { start: src.length, end: src.length, line, col } });
  return { tokens, diagnostics };
}

function isDigit(c: string | undefined): boolean { return c !== undefined && c >= '0' && c <= '9'; }
function isIdentStart(c: string | undefined): boolean { return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'); }
function isIdentPart(c: string | undefined): boolean { return isIdentStart(c) || isDigit(c); }
