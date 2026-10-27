# PR #25 — Phase 5.3: system-prompt editor (completion goal S1)

Date: 2026-06-12. Spec: completion goal S1
(`plans/2026-06-10-clod-ui-completion-goal-v1.md`); v2 Task 5.3 (archived).
Substrate: `system_prompt { mode, text }` already flows end-to-end —
`SubmitTurnInput.system_prompt` (contracts client) → POST body →
`parseTurnBody` → `TurnRequest.system_prompt` → `compose()` →
`--append-system-prompt` / `--system-prompt` argv. What's missing is the
UI surface and the spine pinning.

## Objective

A user writes a per-conversation system prompt in a collapsible editor in
the turn-controls area; the next turn's `claude` argv observably carries
`--append-system-prompt <text>` (default) or `--system-prompt <text>`
(override, behind a dismissible warning).

## Pinned decisions

- **D1 — parser tightening: malformed `system_prompt` → 400.** Today
  `parseTurnBody` silently drops a present-but-malformed `system_prompt`
  (bad `mode`, non-string `text`). Same rationale as PR #24 D3: `mode` is
  a closed vocabulary we own, and silently dropping a system prompt
  silently changes what the model sees — worse than effort. Goal doc said
  "UI-only plus tests"; this is a deliberate small amendment under
  standing constraint 6 (reality wins), reversible, spine-pinned. Absent
  field stays absent; empty-string `text` stays lenient (operator wire
  control — the UI just never sends it).
- **D2 — state shape + draft semantics.** `TurnControls.system_prompt?:
  { mode: 'append' | 'override'; text: string }` (reuses the wire shape;
  no new contracts schema — the body parser is hand-rolled and the client
  type already exists). App state may hold a draft with empty/whitespace
  `text`; a pure helper `effectiveSystemPrompt(controls)` in
  `lib/turn-controls.ts` returns the prompt only when `text.trim()` is
  non-empty. App's `handleSubmit` spreads via the helper, mirroring
  model/effort. UI never sends an empty prompt.
- **D3 — append is the default mode.** Switching to override surfaces a
  warning (ToS-conscious, per v2 Task 5.3: replacing CC's system prompt
  is the sharp knife). Warning is dismissible; dismissal is local
  component state per mount — `key={selectedId}` in App resets it per
  conversation, same precedent as the bar's "Custom…" mode.
- **D4 — `<SystemPromptEditor />`, own file, composed inside
  `TurnControlsBar`.** Bar props unchanged (`value`/`onChange` already
  carry the whole `TurnControls`). Toggle button sits in the bar row
  ("System prompt", with an active dot when `effectiveSystemPrompt` is
  set); the editor panel renders full-width below when expanded.
  Expanded is local `useState`, initially `value.system_prompt !==
  undefined` so renderToString variant tests can reach the open state.
  Collapsed by default otherwise — a collapsible editor, not an
  always-open textarea (goal S1 pin).
- **D5 — live char count; token estimate descoped.** Char count is
  derived and free. A token estimate would be a guess presented as a
  number; plant `// TODO(token-estimate)` instead.
- **D6 — spine extension lives in the T1.17 file** (existing contract
  grows tests; no new T-id — controls passthrough is one behavior
  family). +3 tests: append mode body → `--append-system-prompt <text>`
  argv; override mode → `--system-prompt <text>`; malformed
  `system_prompt` → 400, never reaches the backend. 33 → 36 spine tests,
  17 files.
- **D7 — markers (I-3).** `data-test`: `system-prompt-toggle`,
  `system-prompt-editor`, `system-prompt-mode`, `system-prompt-text`,
  `system-prompt-count`, `system-prompt-warning`,
  `system-prompt-warning-dismiss`. Editor `data-state="collapsed |
  expanded"`; toggle `data-active="true|false"`.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Engine + spine:** `parseTurnBody` D1 tightening + tests (append /
   override / malformed-mode / non-string-text / absent); T1.17 +3 tests;
   SPINE.md row update.
3. **Web:** `lib/turn-controls.ts` (`system_prompt` field +
   `effectiveSystemPrompt`), `components/system-prompt-editor.tsx`,
   TurnControlsBar composition, App submit wiring. Tests: bun
   renderToString variants (collapsed default, active toggle, expanded
   with mode/count, override warning, disabled); vitest dom interactions
   (toggle, type → onChange + count, mode switch → warning, dismiss,
   clear → draft kept but inactive).
4. **Docs:** SPINE/README counts, CLAUDE.md WIP + file map, PROGRESS.md,
   rotate plan → landed, INDEX, NEXT-SESSION.md rewrite. Includes the
   named inspection moment: stale "30 tests / 16 files" intro in SPINE.md
   and CLAUDE.md test-infrastructure section (PR #24 rotation missed
   them; the SPINE total row was already correct).

## Deferred (named TODOs planted in source)

- `TODO(token-estimate)` — optional token estimate next to char count.
- `TODO(system-prompt-presets)` — saved/named prompts; needs persistence
  (`TODO(controls-persistence)` already covers the state half).

## Commits

1. `docs(plans): PR #25 system-prompt-editor plan + INDEX row`
2. `feat(engine): 400 on malformed system_prompt + spine T1.17 system-prompt passthrough`
3. `feat(web): collapsible system-prompt editor in turn controls`
4. `docs: land PR #25 — rotate plan, SPINE/README/CLAUDE/PROGRESS refresh`
