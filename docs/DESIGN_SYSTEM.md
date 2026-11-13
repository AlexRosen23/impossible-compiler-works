# Design system — "a dark logic cathedral"

## Tokens (`web/src/styles.css`)

| token | hex | use |
|---|---|---|
| void plum | `#11101B` | page and canvas ground |
| ink | `#20202E` | panels, table headers |
| porcelain | `#F0ECE4` | primary text, ordinary states |
| indigo | `#9C9BDC` | structure: section titles, initial-state rings, transitions, loop-back of a lasso |
| oath gold | `#C4A66E` | the witness thread, primary actions, changed values, unexplored (dashed) |
| proof mint | `#80B9A1` | verified-in-bounded-model, intended terminal states |
| error vermilion | `#D07878` | violations, deadlocks, rejected receipts |
| muted | `#A6A2B4` | secondary text (raised from the first draft to pass WCAG AA at 4.5:1 on ink) |

Type: a book serif (Iowan Old Style / Palatino / Georgia) for headings and verdicts, a
humanist sans for UI, SF Mono / ui-monospace for state values, actions and hashes. No web
fonts are fetched, so the offline demo has no network dependency.

## Layout

Three columns on desktop: Specification Desk (~26%), Possibility Chamber (the rest, ~70% of a
34-inch ultrawide), Precision Rail (≈300 px), with the analysis rooms in a tabbed deck
underneath. At ≤1100 px the chamber spans the top; at ≤720 px everything stacks and the page
never scrolls horizontally (E2E-tested at 390 px).

## The graph

- One vertical "nave" per logical step, labelled `step n` — time is step count, never seconds.
- Edges are faint indigo Béziers; the witness is a glowing gold thread over them; a lasso's
  closing step is dashed indigo and arcs back.
- Node encoding: gold = on the witness, vermilion = violates an invariant, ink with vermilion
  ring = deadlock, mint = intended terminal, indigo ring = initial, dashed gold hollow =
  unexplored because of a cap. A legend is always visible.
- When a run finishes, layers appear in step order over ~0.9 s. That motion is decorative;
  "Motion off" or `prefers-reduced-motion` removes it and the glow. A repair visibly shrinks
  the graph because the run result has fewer states, not because anything is hidden.

## Accessibility

- Every graph fact is also available as text: the States table (paginated, filterable,
  keyboard-selectable), the Precision Rail and the Theater's lane table (`role="table"`).
- The canvas is focusable with a descriptive label; arrow keys move to successor / parent /
  layer neighbours, Home to the initial state; selections are announced in a live region.
- Colour is never the only signal: statuses are also words (`VIOLATED`, `DEADLOCK`, …).
- axe-core reports no serious or critical violations on the Bazaar and a workspace (E2E).
  The CodeMirror editor is excluded from that scan (third-party widget); it has an `aria-label`.
