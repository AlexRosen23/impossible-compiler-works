// Source spans and diagnostics. Offsets are UTF-16 code-unit offsets into the source string (what
// editors use); line and column are 1-based.
export interface Span { start: number; end: number; line: number; col: number }

export type Severity = 'error' | 'warning';
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  span: Span;
  /** Optional hint shown under the message. */
  hint?: string;
  stage: 'lex' | 'parse' | 'check' | 'fixture' | 'limits';
}

export const NO_SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };

export function spanFrom(a: Span, b: Span): Span {
  return { start: a.start, end: b.end, line: a.line, col: a.col };
}

/** Locate a 1-based line/col for an offset. */
export function lineColAt(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { line++; col = 1; } else col++;
  }
  return { line, col };
}

export function hasErrors(ds: Diagnostic[]): boolean {
  return ds.some((d) => d.severity === 'error');
}

/** The documented diagnostic codes (docs/TYPE_SYSTEM.md mirrors this table; a test keeps them aligned). */
export const DIAGNOSTIC_CODES: Record<string, string> = {
  L001: 'unexpected character',
  L002: 'unterminated string',
  L003: 'invalid escape in string',
  L004: 'invalid color literal',
  L005: 'unterminated block comment',
  L006: 'string literal too long',
  L007: 'invalid number literal',
  P001: 'unexpected token',
  P002: 'missing scene declaration',
  P003: 'more than one scene declaration',
  P004: 'invalid scene option',
  P005: 'too many syntax errors; parsing stopped',
  C001: 'undeclared name',
  C002: 'type mismatch',
  C003: 'wrong number of arguments',
  C004: 'unknown or duplicate named argument',
  C005: 'missing required named argument',
  C006: 'assignment to an immutable binding',
  C007: 'duplicate declaration in the same scope',
  C008: 'not callable',
  C009: 'function may finish without returning a value',
  C010: 'return outside a function',
  C011: 'drawing inside a function',
  C012: 'recursion is not allowed',
  C013: 'empty list needs a declared element type',
  C014: 'unsupported operation for this type',
  C015: 'nested lists are not supported',
  C016: 'list literal too long',
  C017: 'reserved name',
  C018: 'no field with this name',
  C019: 'invalid scene option value',
  C020: 'duplicate function or data name',
  W001: 'binding shadows an outer binding',
  W002: 'unreachable statement',
  W003: 'unused binding',
  F001: 'fixture missing',
  F002: 'fixture does not match its declared type',
  F003: 'invalid fixture name',
  F004: 'fixture too large',
  S001: 'source too large',
  S002: 'program too large (AST nodes)',
  S003: 'too many symbols',
};
