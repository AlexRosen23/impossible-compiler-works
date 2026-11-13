// The shared shell strip of THE IMPOSSIBLE COMPILER WORKS: one name, both wings, and where it came from.
// Imported by both wings (web/src/main.tsx and wings/compiler/web/src/main.tsx). No app state, no network.
import './shell.css';

export type Wing = 'witness' | 'compiler';

export const SHELL_NAME = 'THE IMPOSSIBLE COMPILER WORKS';
export const SHELL_TAGLINE = 'write it, compile it, prove nothing impossible can happen';
export const SHELL_FORMERLY = 'Formerly Paper Tiger Compiler Works and The Impossible Witness';

export function ShellBar({ wing }: { wing: Wing }) {
  return (
    <header className="icw-shell" data-testid="icw-shell" aria-label={SHELL_NAME}>
      <span className="icw-shell__name">{SHELL_NAME}</span>
      <span className="icw-shell__tagline">{SHELL_TAGLINE}</span>
      <nav className="icw-shell__wings" aria-label="Wings">
        <a href="/compiler/" aria-current={wing === 'compiler' ? 'page' : undefined}>Compiler wing</a>
        <a href="/" aria-current={wing === 'witness' ? 'page' : undefined}>Witness wing</a>
      </nav>
      <span className="icw-shell__formerly" data-testid="icw-formerly">{SHELL_FORMERLY}</span>
    </header>
  );
}
