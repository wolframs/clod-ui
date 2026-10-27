# PR #28 — Phase 5.8: raw-flags escape hatch (completion goal S4)

Date: 2026-06-12. Spec: completion goal S4
(`plans/2026-06-10-clod-ui-completion-goal-v1.md`); architecture Task 5.8.
Substrate: `ComposeOptions.extraArgv` (PR #3) appends verbatim after all
composed flags — compose-tested, no production caller. Nothing per-turn,
nothing on the wire, no UI.

## Objective

A power user types raw `claude` flags for a conversation; the next
turn's argv carries them verbatim at the tail, after every composed
flag — able to add or override anything. Loud warning in the UI; loud
400 on malformed wire input.

## Pinned decisions

- **D1 — per-turn `extra_argv?: string[]` on `TurnRequest` + the wire.**
  `compose()` appends it last: composed flags → `opts.extraArgv`
  (backend-level seam, kept — it's config, not a turn control) →
  `req.extra_argv` (most specific wins by trailing duplication, the
  CLI's last-flag-wins behavior already pinned in compose tests).
- **D2 — strict validation in `parseTurnBody`.** Present-but-malformed
  (non-array, or any non-string element) → 400. Raw argv is the
  sharpest control on the wire; silently filtering elements would spawn
  a different command than the operator wrote (same stance as PR #24 D3
  / PR #25 D1). Empty array → field absent (argv-identical; compose
  guards `length > 0`). Note the deliberate contrast: `allowed_tools`
  silently filters non-strings (open list, additive) — argv does not.
- **D3 — UI state is a text draft; tokens split on newlines.**
  `TurnControls.extra_argv_text?: string` (the editor draft) + pure
  `parseExtraArgv(text): string[]` in `lib/turn-controls.ts`: split on
  newlines, trim each line, drop empties. One token per line — no shell
  quoting/space-splitting ambiguity to explain or get wrong; `--model
  opus` is two lines. `effectiveExtraArgv(controls)` mirrors the
  system-prompt helper: `undefined` unless ≥1 token.
- **D4 — `<RawFlagsEditor />`, collapsed + off by default.** Same shape
  as `<SystemPromptEditor />` (PR #25): toggle in the controls row
  (active dot when tokens exist), panel below, expanded initially only
  when a draft exists. The warning is **always visible while tokens are
  non-empty** (goal pin) — not dismissible, unlike the override warning:
  raw flags stay sharp every turn. Token count in the panel footer.
- **D5 — markers (I-3).** `data-test`: `raw-flags-toggle` (+
  `data-active`), `raw-flags-editor` (`data-state="collapsed|expanded"`),
  `raw-flags-text`, `raw-flags-warning`, `raw-flags-count`.
- **D6 — spine: extend T1.17** (turn-controls passthrough family). +2
  tests: (1) `extra_argv` survives the wire and composes verbatim as the
  argv tail — `argv.slice(-n)` equals the tokens, positioned after the
  `--add-dir` block; (2) malformed `extra_argv` → 400, never reaches the
  backend. 36 → 38 spine tests.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Contracts/engine:** `SubmitTurnInput.extra_argv` (contracts client
   type), backend `TurnRequest.extra_argv` + compose tail append (+
   compose unit tests: tail ordering vs opts.extraArgv, empty/absent),
   `parseTurnBody` validation (+ unit tests: valid, empty→absent,
   non-array→400, non-string element→400, absent), spine T1.17 +2,
   SPINE.md row.
3. **Web:** `lib/turn-controls.ts` (`extra_argv_text` + `parseExtraArgv`
   + `effectiveExtraArgv` + pure tests), `components/raw-flags-editor.tsx`
   composed in TurnControlsBar, `use-submit-turn` `SubmitArgs.extra_argv`,
   App submit wiring. Tests: bun variants (collapsed, active, expanded,
   warning-on-nonempty, disabled) + dom interactions (toggle, type →
   tokens + count, clear → inactive, warning appears/disappears).
4. **Docs:** SPINE/README counts, CLAUDE.md WIP + file map, PROGRESS,
   goal doc S4 entry, rotate plan → landed, INDEX (both halves),
   NEXT-SESSION.md.

## Deferred (named, deliberate)

- Flag autocomplete / validation against `claude --help` — would need
  CLI-version-keyed data; the escape hatch's contract is "verbatim".
- Per-turn (vs per-conversation) raw flags — controls are per-conv by
  design (PR #24 D5); nothing new here.

## Commits

1. `docs(plans): PR #28 raw-flags plan + INDEX row`
2. `feat(contracts,backend,engine): per-turn extra_argv on the wire + spine T1.17 tail ordering`
3. `feat(web): raw-flags editor in turn controls`
4. `docs: land PR #28 — rotate plan, SPINE/CLAUDE/PROGRESS refresh`
