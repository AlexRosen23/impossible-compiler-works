// Shared by both wings' HTTP servers: refuse JSON bodies nested deeper than any real request, before JSON.parse
// and before any recursive walker (canonical JSON, receipt checks) can overflow the stack.
/** Receipts and requests nest a handful of levels; anything deeper is hostile (recursive walkers would overflow). */
export const MAX_JSON_DEPTH = 64;

/** Maximum bracket nesting of a JSON text, ignoring brackets inside strings. O(n), no recursion. */
export function jsonDepth(text: string): number {
  let depth = 0, max = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (c === 92) i++; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) { if (++depth > max) max = depth; }
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}
