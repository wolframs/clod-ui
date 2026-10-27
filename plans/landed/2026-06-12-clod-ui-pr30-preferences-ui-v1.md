# PR #30 — Phase 5.4: preferences UI (completion goal S6)

Date: 2026-06-12. Spec: completion goal S6
(`plans/2026-06-10-clod-ui-completion-goal-v1.md`); v2 Task 5.4.
Substrate: `GET/PUT/PATCH /settings` routes (opt-in, I-1) + typed client
methods + `ClaudeSettingsSchema` (documented keys `theme`/`model`/
`allowedTools`/`disallowedTools` + verbatim `unknown` bucket) + atomic
`.bak` IO (I-6) + spine T1.09. Missing: `useSettings`, any UI.

## Objective

The user views and edits CC's real `settings.json` from the UI —
documented keys in a schema-aware form, unknown keys read-only, a diff
preview making every write deliberate — round-tripped through the
existing atomic engine path.

## Pinned decisions

- **D1 — `useSettings` follows the I-2 template** (goal pin): `loading |
  ok | error | not_configured`, mirroring `useTranscript`'s lifecycle
  (cancellation ref, abort on unmount, `refetch`). Plus `save(next:
  ClaudeSettings)` → `client.putSettings` → state updates to the
  response on resolve; a `saving` boolean rides the `ok` variant. PUT
  (not PATCH): the form edits the whole document, and PUT-what-you-see
  composes with the diff preview; PATCH stays a client capability.
- **D2 — `<SettingsPanel />` modal overlay**, opened from a footer
  "Settings" button (next to ThemeToggle); `settingsOpen` lives in App
  (same pattern as the shortcut overlay; Escape closes via the existing
  `escape` action priority: shortcut overlay > settings > cancel turn).
  Fetch on open: `useSettings({ enabled: settingsOpen })`.
- **D3 — form state is panel-local draft** (the Composer-textarea
  precedent — interactivity forces it): initialized from the loaded
  settings, reset when the loaded object identity changes (adjust-on-
  prop-change during render, PR #19.1 pattern). Fields: `theme` select
  over `ClaudeThemeSchema.options` + "(unset)"; `model` free text
  (empty = unset); `allowedTools`/`disallowedTools` newline-separated
  textareas (one entry per line — the `extra_argv` precedent; chips
  reuse is a refactor the slice doesn't need). `unknown` bucket
  rendered as a read-only `<pre>` JSON block, passed through PUT
  byte-identical.
- **D4 — diff preview before PUT (goal pin).** Pure
  `diffSettings(current, draft)` → `Array<{ key, from, to }>` over
  documented keys only (the form can't change `unknown`). Save button →
  diff confirmation view ("theme: dark → light"; unset rendered as
  `(unset)`) → Confirm issues the PUT. No changes → Save disabled.
  The diff is the deliberateness required for writing CC's real file.
- **D5 — not_configured variant renders the `--persist` affordance**
  (goal pin), matching the Sidebar's wording: the engine started
  without settings support.
- **D6 — markers (I-3).** Panel `data-test="settings-panel"`,
  `data-state="loading|ok|error|not_configured|confirming"`; fields
  `settings-theme`, `settings-model`, `settings-allowed`,
  `settings-disallowed`; `settings-unknown` (read-only block);
  `settings-save`, `settings-confirm`, `settings-cancel-confirm`,
  `settings-close`; diff rows `settings-diff-row` + `data-key`.
- **D7 — no spine change.** T1.09 already pins the engine round-trip;
  the UI exit criterion is dom-tested round-trip (goal pin).

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Pure logic:** `lib/settings-form.ts` — `diffSettings`, draft ↔
   form-field codecs (`linesToList`/`listToLines` reusing
   `parseExtraArgv`-style splitting), `applyDraft(current, draft)`
   (documented keys only, `unknown` carried verbatim). Bun tests as
   data.
3. **Hook:** `lib/use-settings.ts` (+ dom tests: lifecycle to each
   status, save → putSettings with merged doc → ok updates,
   not_configured via `ClientError.kind`).
4. **UI:** `components/settings-panel.tsx` (+ bun variants per D6
   state; dom test: edit theme → Save → diff row shown → Confirm →
   `putSettings` called with `unknown` preserved). Footer button + App
   wiring (state, escape priority, overlay render).
5. **Docs:** CLAUDE.md WIP + file map, PROGRESS, goal doc S6 entry,
   rotate plan → landed, INDEX (both halves), NEXT-SESSION.md.

## Deferred (named, deliberate)

- Editing the `unknown` bucket — read-only by pin; a raw-JSON editor is
  a different risk class.
- `TODO(settings-live-refresh)` — panel refetches on open only; no
  file-watcher push.

## Commits

1. `docs(plans): PR #30 preferences-ui plan + INDEX row`
2. `feat(web): settings form codecs + diff (pure)`
3. `feat(web): useSettings hook (I-2 discriminated template)`
4. `feat(web): settings panel + footer entry + App wiring`
5. `docs: land PR #30 — rotate plan, CLAUDE/PROGRESS refresh`
