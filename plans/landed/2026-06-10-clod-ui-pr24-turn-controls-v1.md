# PR #24 — Phase 5.1 + 5.2: turn controls (model picker + thinking effort)

Date: 2026-06-10. Spec: architecture v3 §Open Phase 5; v2 Tasks 5.1/5.2
(archived). Substrate: flag composer (PR #3) — `compose()` already maps
`model` → `--model` and `thinking_effort` → `--effort` via
`THINKING_EFFORT_MAP`. What's missing is the wire path (body → TurnRequest)
for `thinking_effort` and the entire UI surface for both controls.

## Objective

A user picks a model and a thinking effort per conversation in the UI; the
next turn's `claude` argv observably carries `--model <x>` / `--effort <y>`.
First slice of "first-class controls changing argv observably" (v3
verification criterion ⏳).

## Pinned decisions

- **D1 — controls travel per-turn in the existing POST body.** No new
  endpoint, no settings write, no manifest event. The composer is the seam;
  the body already carries `model`. Anything fancier (per-conv persistence)
  is deferred.
- **D2 — `ThinkingEffort` becomes a contracts type.**
  `packages/contracts/src/turn.ts`: `ThinkingEffortSchema =
  z.enum(['off','think','think_hard','think_harder','ultrathink'])`.
  Backend `TurnRequest.thinking_effort` re-types from it (alias, no
  behavior change; `THINKING_EFFORT_MAP` untouched). Contracts is the
  bottom layer; backend already depends on it.
- **D3 — invalid `thinking_effort` in the body → 400.** Unlike the open
  string fields (`model`, `cwd`) which `parseTurnBody` passes through or
  drops leniently, effort is a closed vocabulary we own. Silently dropping
  a typo would silently change thinking depth — counter to the
  expose-the-wire premise. Deliberate asymmetry; documented in the parser.
- **D4 — curated model list = CLI aliases, custom = free text.**
  `KNOWN_MODELS = ['fable', 'opus', 'sonnet', 'haiku']` in
  `apps/web/src/lib/turn-controls.ts` (UI affordance, not a wire
  contract). Aliases track the latest snapshot per tier and rot slower
  than dated IDs; the CLI accepts both, and "Custom…" takes any full ID.
  `// TODO(model-discovery)` — v2 Task 5.1's dynamic discovery is its own
  slice.
- **D5 — App owns per-conversation control state.**
  `Record<conv_id, TurnControls>` where `TurnControls = { model?,
  thinking_effort? }`; `{}` = "CLI decides" (no flags composed). Lost on
  reload. `// TODO(controls-persistence)` (localStorage or engine-side),
  `// TODO(controls-global-default)` (settings `model` key as default).
- **D6 — UI never sends `'off'`.** `'off'` and absent are argv-identical
  (both emit no `--effort`), so the picker's default option means "field
  absent". The enum keeps `'off'` for wire compatibility only.
- **D7 — `<TurnControlsBar />` pure-ish presentational.** Props:
  `{ value, onChange, disabled? }`. Local `useState` only for the
  "Custom…" entry mode (same precedent as Composer's textarea). Rendered
  into Composer via a new optional `controls?: ReactNode` slot prop —
  Composer stays agnostic of what the controls are. `data-test` markers:
  `turn-controls`, `turn-controls-model`, `turn-controls-model-custom`,
  `turn-controls-effort-<value>`; `data-selected` on the active effort
  segment (I-3).
- **D8 — new spine contract T1.17 (controls passthrough).** Real
  `createApp` + typed client; a recording wrapper around `ScriptedBackend`
  captures the `TurnRequest`; assert `model` + `thinking_effort` survive
  the wire and that `compose()` of the captured request yields
  `--model`/`--effort` pairs. Plus: absent fields stay absent; invalid
  effort → 400. Append SPINE.md row + README count.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Contracts:** `turn.ts` (schema + type + values export), barrel export,
   `SubmitTurnInput.thinking_effort`. Backend `TurnRequest` re-types.
   Engine `parseTurnBody` accepts/rejects per D3.
   Spine `T1.17-turn-controls-passthrough.test.ts`.
3. **Web:** `lib/turn-controls.ts` (types + `KNOWN_MODELS` + pure helpers),
   `components/turn-controls-bar.tsx`, Composer `controls` slot,
   `useSubmitTurn` `SubmitArgs.thinking_effort`, App wiring (state record +
   submit args + slot).
4. **Docs:** SPINE.md, README spine count, CLAUDE.md WIP + file map,
   PROGRESS.md, rotate plan → landed, INDEX, NEXT-SESSION.md rewrite.

## Tests

- `apps/engine/tests/parse-turn-body.test.ts` (new): valid effort accepted,
  invalid → error, model passthrough, absent-field behavior.
- `packages/contracts/tests/turn.test.ts`: enum accept/reject.
- `apps/web/tests/turn-controls-bar.test.tsx` (bun, renderToString):
  variants — default, known model selected, custom model, effort selected,
  disabled; marker assertions only.
- `apps/web/tests/dom/turn-controls-bar.test.tsx` (vitest): interaction —
  select known model fires `onChange`, "Custom…" flow commits typed ID,
  effort segment click round-trips, default option clears the field.
- `tests/spine/T1.17-*.test.ts`: 3 tests per D8.

## Deferred (named TODOs planted in source)

- `TODO(model-discovery)` — dynamic model list (engine probe + fallback).
- `TODO(controls-persistence)` — survive reload.
- `TODO(controls-global-default)` — settings-backed default model.
- Note for a future tape PR: `THINKING_EFFORT_MAP` has no `xhigh`; the
  CLI's effort vocabulary grew since PR #3. Tape tests should pin this.

## Commits

1. `docs(plans): PR #24 turn-controls plan + INDEX row`
2. `feat(contracts,engine): thinking_effort on the turn wire + T1.17`
3. `feat(web): model picker + thinking effort controls`
4. `docs: land PR #24 — rotate plan, SPINE/README/CLAUDE/PROGRESS refresh`
