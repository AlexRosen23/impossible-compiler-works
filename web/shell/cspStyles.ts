// Static demo only. The demo host serves a Content-Security-Policy without 'unsafe-inline' for styles, so
// CodeMirror's injected <style> element would be blocked. Mount its style modules through a constructable
// stylesheet instead (allowed by CSP). The rules go into a cascade layer so that the app's own stylesheet wins ties,
// exactly as it does when CodeMirror's <style> element sits first in <head>.
import { StyleModule } from 'style-mod';

interface Mod { getRules(): string }

export function installCspSafeStyles(): void {
  if (typeof document === 'undefined' || !document.adoptedStyleSheets || typeof CSSStyleSheet === 'undefined') return;
  const sheet = new CSSStyleSheet();
  const mods: Mod[] = [];
  const mount = (r: unknown, m: unknown): void => {
    if (r !== document) return;
    const list = (Array.isArray(m) ? m : [m]) as Mod[];
    let j = 0, changed = false;
    for (const mod of list) {
      let idx = mods.indexOf(mod);
      if (idx > -1 && idx < j) { mods.splice(idx, 1); changed = true; idx = -1; j--; }
      if (idx === -1) { mods.splice(j++, 0, mod); changed = true; } else { j = idx + 1; }
    }
    if (changed) sheet.replaceSync(`@layer cm{${mods.map((x) => x.getRules()).join('\n')}}`);
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [sheet, ...document.adoptedStyleSheets];
  };
  (StyleModule as unknown as { mount: typeof mount }).mount = mount;
}
