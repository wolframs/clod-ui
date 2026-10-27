# PR #29 — Phase 5.5: active tools editor (completion goal S5)

Date: 2026-06-12. Spec: completion goal S5
(`plans/2026-06-10-clod-ui-completion-goal-v1.md`); v2 Task 5.5.
Substrate: `allowed_tools` / `disallowed_tools` flow end-to-end —
body → `parseTurnBody` (silent non-string filtering, open additive list —
the documented contrast to `extra_argv`) → `TurnRequest` → `compose()`
(`--allowedTools` / `--disallowedTools`); resume-turn argv pinned by
T1.02. `SubmitArgs` already carries both. Missing: UI + the POST-body
spine pin.

## Objective

A user curates per-conversation tool allow/disallow lists — builtin
checkboxes plus free-form entries like `Bash(npm run *)` — and the next
turn's argv observably carries `--allowedTools` / `--disallowedTools`.

## Pinned decisions

- **D1 — wire shape directly in state.** `TurnControls.allowed_tools?:
  string[]` + `disallowed_tools?: string[]` — entries are discrete chips,
  no text draft needed (unlike `extra_argv_text`). Empty array never
  stored: helpers drop the key (absent = CLI decides, PR #24 D5).
- **D2 — curated builtin list.** `KNOWN_TOOLS` in `lib/turn-controls.ts`:
  Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Task,
  TodoWrite, NotebookEdit — UI affordance, not a wire contract (same
  status as `KNOWN_MODELS`, D4 of PR #24). MCP tool discovery is OUT —
  no MCP surface exists yet; noted, not built (goal pin).
- **D3 — entry grammar helper (pure).** `parseToolEntry(raw)` →
  `{ name, pattern? } | null`: bare name (`Read`) or `Name(pattern)`
  (`Bash(npm run *)`); null for malformed (empty name, unbalanced/extra
  parens, empty pattern). `formatToolEntry` is its inverse. The editor
  refuses to add a null parse and shows the `Bash(...)` hint — that's
  the "small grammar helper", not a shell parser.
- **D4 — one `<ToolsEditor />`, two sections.** Third collapsible in the
  controls area (the row holds: model select, effort segments, three
  toggles; panels stack full-width below — no layout rethink needed
  yet). Each section (Allowed / Disallowed): curated checkboxes
  (checked = bare name present in the list) + free-form input with Add
  (Enter or button) + every entry rendered as a chip with a remove ×.
  Pattern entries (`Bash(npm run *)`) exist only as chips — checkboxes
  cover bare names. Duplicate adds are no-ops.
- **D5 — markers (I-3).** `data-test`: `tools-toggle` (+ `data-active`
  when either list is non-empty), `tools-editor`
  (`data-state="collapsed|expanded"`), per section `tools-<kind>`
  (kind ∈ allowed|disallowed), `tools-<kind>-builtin-<Name>`
  (checkbox), `tools-<kind>-input`, `tools-<kind>-add`,
  `tools-<kind>-chip` (+ `data-entry`), chip remove
  `tools-<kind>-remove`.
- **D6 — spine: extend T1.17** (+1 test): `allowed_tools` +
  `disallowed_tools` in the POST body reach the backend unmodified and
  compose to `--allowedTools <entries…>` / `--disallowedTools
  <entries…>` argv (multi-value form already pinned in compose tests;
  this pins the wire path end-to-end, which T1.02 only covers for the
  engine-injected resume path). 38 → 39.
- **D7 — App submit wiring** mirrors the other controls:
  `effectiveTools(controls)` not needed — lists are already wire-shaped;
  spread `...(controls.allowed_tools?.length && { allowed_tools })`.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Pure logic:** `KNOWN_TOOLS` + `parseToolEntry` / `formatToolEntry`
   + add/remove list helpers (`toggleToolEntry`) in
   `lib/turn-controls.ts` + bun tests (grammar accept/reject table,
   dedupe, empty-list key dropping).
3. **Wiring:** `components/tools-editor.tsx` composed in TurnControlsBar;
   App submit spread. Tests: bun variants (collapsed, active dot,
   expanded sections, chips render entries, disabled) + dom interactions
   (checkbox round-trip, free-form add via Enter, malformed input
   refused, chip remove, duplicate no-op).
4. **Spine** T1.17 +1 + SPINE.md row/total.
5. **Docs:** README counts, CLAUDE.md WIP + file map, PROGRESS, goal doc
   S5 entry, rotate plan → landed, INDEX (both halves), NEXT-SESSION.md.

## Deferred (named, deliberate)

- MCP tool discovery — no MCP surface exists; revisit when one does
  (goal pin; no TODO marker, it's S-queue-external).
- Permission-mode controls (`--permission-mode`) — different flag
  family, not part of Task 5.5.

## Commits

1. `docs(plans): PR #29 tools-editor plan + INDEX row`
2. `feat(web): tool-entry grammar + curated tool list (pure)`
3. `feat(web): tools editor in turn controls + spine T1.17 tools passthrough`
4. `docs: land PR #29 — rotate plan, SPINE/CLAUDE/PROGRESS refresh`
