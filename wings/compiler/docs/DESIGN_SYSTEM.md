# Design system

An editorial printing workshop crossed with a language research lab: cream type on carbon, crimson (oxblood)
marks for what matters, brass for structure, fine rules instead of boxes, monospace for anything the machine
produced. The rules below are enforced by `web/src/styles.css` tokens; new UI uses the tokens, never raw colours.

## Tokens
| token | value | use |
|---|---|---|
| `--carbon` | #101013 | page and editor background |
| `--slate` | #202126 | controls, dialogs |
| `--rule` / `--rule-soft` | #34353c / #26272d | 1 px dividers (prefer a rule to a card) |
| `--cream` | #F0EADD | primary text; FOLIO's default fill |
| `--brass` | #BB9C67 | structure: stage numbers, sub-headings, focus ring, entry blocks |
| `--oxblood` | #B2534F | the one accent: primary action, errors, active tab, cursor, removed code |
| `--chalk` | #98ABB9 | types |
| `--mint` | #8DB7A2 | verified / agreeing / passing |
| `--serif` | Iowan Old Style → Charter → Georgia | display (wordmark, section titles, numbers in stats) |
| `--mono` | SF Mono → Menlo | code, diagnostics, hashes, labels |
| `--sans` | system UI | body copy and buttons |

System font stacks only: the app makes no third-party font requests (the server's CSP allows only `'self'`).

## Rules
1. **Colour carries meaning, never decoration.** Oxblood = action or failure; mint = verified; brass =
   structure; chalk = type. A green tick appears only where a real check ran.
2. **Machine output is monospace.** Anything the compiler, VM or server produced (tokens, IR, hashes, codes)
   is set in `--mono`.
3. **Every visual is grounded.** Pipeline stage cards show the actual StageRecord (summary, ms, output hash).
   The stage "light-up" animation plays only after a real compile, in stage order. Scenes come only from
   executed FOLIO programs. Nothing on screen is a static mock-up presented as output.
4. **Focused modes, not card walls.** Eight modes share one editor; each mode is one inspector, at most two
   columns plus a footer.
5. **Motion is optional.** Animations are short (≤ 0.5 s), and `prefers-reduced-motion: reduce` removes them.
   No information is conveyed by motion alone.
6. **Accessible alternatives.** The scene canvas has an `aria-label` summary and a visually hidden table of
   shapes. The CFG has an `aria-label` and the IR listing beside it is the text form. The AST is a keyboard-
   navigable list of buttons (arrow keys expand and collapse). Every button has an accessible name (E2E-checked).
   Mode tabs use `role=tab`.
7. **No untrusted markup.** FOLIO strings are drawn with canvas `fillText` or rendered as React text, never
   as HTML. The E2E suite checks that a FOLIO `<img onerror>` string creates no element.

## Layout
- Desktop (≥ 1180 px): editor (34%) | pipeline rail (19%) | scene, in Editorial; editor | inspector elsewhere.
- Laptop and tablet (861–1180 px): editor | inspector; the rail folds into the stage view.
- Phone (≤ 860 px): a single column, editor then scene, for reading and playing examples; no horizontal page
  scroll (E2E-checked at 390 px).
- Ultra-wide (≥ 2000 px): larger base type.

## Screenshots
Real captures from the E2E run are in `evidence/screenshots/`.
