import type { Span } from './syntax/ast.ts';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  span?: Span;
}

export class DiagnosticError extends Error {
  code: string;
  span?: Span;
  constructor(code: string, message: string, span: Span | undefined) {
    super(message);
    this.code = code;
    this.span = span;
  }
  toDiagnostic(): Diagnostic {
    return { code: this.code, severity: 'error', message: this.message, span: this.span };
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.span ? `${d.span.line}:${d.span.col}` : '-';
  return `${d.severity.toUpperCase()} ${d.code} at ${where}: ${d.message}`;
}
