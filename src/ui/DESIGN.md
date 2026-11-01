# First direction: a quieter workbench

## Grounding

`src/extensions/api/api.ts` owns HTTP transport. `ThreadDirectory` lists keys,
conversation IDs, and creation time. `TurnCoordinator` admits idempotent turns and
reads retained `ReplyPage` objects (`replies`, `next`, `truncated`). Replies carry
`user` or `activity-result` sources. None of these endpoints expose active WORK,
project records, or full historical owner messages. GET replies can create a
thread, so the UI only reads selected existing or locally submitted threads.
The adapter is unauthenticated: same-origin hosting is not an auth mechanism.

## Two concrete layout sketches

```text
A / conversation workbench (chosen)
┌──────────────┬──────────────────────────┬────────────────┐
│ threads      │ transcript               │ current context│
│ search       │ decision inline          │ work in view   │
│ new / demo   │ composer                 │ limitations    │
└──────────────┴──────────────────────────┴────────────────┘

B / activity-first board
┌─────────────────────────────────────────────────────────┐
│ project / thread tabs                                   │
├──────────────────┬──────────────────┬───────────────────┤
│ in progress      │ needs input      │ completed         │
│ work cards       │ approval cards   │ reports           │
├──────────────────┴──────────────────┴───────────────────┤
│ collapsible conversation drawer + composer               │
└─────────────────────────────────────────────────────────┘
```

B helps triage many concurrent workers but subordinates the conversation and
requires a work-status API that does not exist. A makes the existing API useful
now without inventing lifecycle semantics. The context rail can later accept real
WORK data without displacing the conversation. On tablet it stacks below chat;
on phone navigation is a disclosure, not a squeezed permanent column.

Warm off-white surfaces, forest green accents, fine borders, bundled DM Sans /
Manrope typography and a serif welcome moment establish hierarchy without a
dashboard full of metrics. Text labels accompany colored status indicators.

## Module contract

- `api.ts`: fetch, schema validation, transport errors; no UI state.
- `model.ts`: local session/outgoing types and pure pending-turn selection.
- `App.tsx`: thread-scoped in-memory sessions/drafts, request admission,
  abortable serial polling, navigation and composer.
- `Conversation.tsx`: typed shared message/badge/transcript presentation.
- `Demo.tsx`: explicit simulated transcript and work/project cards. No API import.
- `styles.css`: responsive layout, focus, readable secondary copy, reduced motion.

**Boundary discipline** keeps external response validation in `api.ts` rather
than scattering guards through rendering. **Exhaust the design space** led to
comparing the two whole-layout sketches above rather than two visual themes.
The sketch PR could not be discovered through the supplied read tools (no PR-list
operation, `gh` unavailable, private GitHub page returned 404). Proceeding from
main was explicitly approved; no existing PR was merged, overwritten or dismissed.
