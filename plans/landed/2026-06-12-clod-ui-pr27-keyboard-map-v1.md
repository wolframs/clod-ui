# PR #27 — Phase 7.1: keyboard map (completion goal S3)

Date: 2026-06-12. Spec: completion goal S3
(`plans/2026-06-10-clod-ui-completion-goal-v1.md`). Substrate: none —
first keyboard surface in the app. Composer's Enter/Shift+Enter handling
stays local to its textarea and is untouched.

## Objective

The five pinned actions work from the keyboard: new conversation, focus
composer, cancel active turn, prev/next conversation, and a `?` overlay
that documents them. No library; keymap is data.

## Pinned decisions

- **D1 — bindings (data, single source for dispatch + overlay).**
  `lib/keymap.ts` exports `KEYMAP: readonly KeyBinding[]`:
  | key | action | notes |
  |---|---|---|
  | `n` | `new_conversation` | not in editable elements |
  | `/` | `focus_composer` | not in editable; preventDefault (Firefox quick-find) |
  | `j` | `next_conversation` | not in editable |
  | `k` | `prev_conversation` | not in editable |
  | `?` | `toggle_help` | not in editable (Shift produces the char; Shift is not a blocking modifier) |
  | `Escape` | `escape` | fires everywhere, incl. editables; no preventDefault |
  `KeyBinding = { key, action, description, inEditable, preventDefault }`.
- **D2 — `escape` is one action; the consumer owns priority.** App
  resolves: help overlay open → close it; else active streaming turn →
  cancel it; else no-op. Keeps the keymap pure data and the policy where
  the state lives (same spirit as I-7).
- **D3 — guards.** `matchBinding(key, ctx)` with `ctx = { inEditable,
  isComposing, hasModifier }`: composing → never match (IME);
  ctrl/meta/alt → never match (browser shortcuts stay browser's; Shift
  deliberately excluded so `?` works); `inEditable` blocks bindings not
  flagged for editables. `contextFromEvent(ev)` derives ctx (editable =
  INPUT/TEXTAREA/SELECT or `isContentEditable`).
- **D4 — one hook, ref-stable handler.** `useKeymap(onAction)` attaches a
  single `window` keydown listener once; the callback lives in a ref
  updated during render (the `useSubscribe` precedent) so consumers can
  pass inline closures without re-subscribing.
- **D5 — `<ShortcutOverlay />` pure presentational.** Props `{ open,
  onClose }`; `null` when closed; rows rendered from `KEYMAP` (the data
  is the documentation — no second list to drift). Markers (I-3):
  `data-test="shortcut-overlay"`, `data-state="open"`, rows
  `data-test="shortcut-overlay-row"` + `data-action`. Backdrop click +
  the `?`/Escape keys close it (via App state, not internal state, I-4).
- **D6 — App wiring.** `helpOpen` state in App; `focus_composer` needs a
  textarea handle — Composer gains an optional `inputRef` prop (its
  internal ref is currently write-only). prev/next walk the sidebar list
  when `conversations.status === 'ok'`: current id absent → select the
  first entry; ends clamp (no wrap). `new_conversation` reuses
  `handleNewConversation`; cancel reuses `handleCancel` with the same
  turn-id fallback chain the Composer uses (stream turn_id, else
  `submit.lastTurnId`).
- **D7 — no spine change.** Keyboard handling is not wire-observable.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Pure logic:** `lib/keymap.ts` (+ bun tests: every binding matched
   under a permissive ctx; modifier/composing/editable guards; Escape
   allowed in editables; unknown keys; key uniqueness as a data
   invariant).
3. **Wiring:** `lib/use-keymap.ts` (+ dom tests: window keydown fires the
   action; `n` suppressed inside a textarea while Escape isn't; ctrl+key
   suppressed; preventDefault per binding), `components/shortcut-overlay.tsx`
   (+ bun variant tests: closed renders nothing, open renders one row per
   KEYMAP entry), Composer `inputRef` prop, App wiring (helpOpen +
   action dispatch + overlay render).
4. **Docs:** CLAUDE.md WIP + file map, PROGRESS, goal doc S3 entry,
   rotate plan → landed, INDEX, NEXT-SESSION.md.

## Deferred (named, no TODO markers — different features, not debt)

- Configurable bindings / chords — out of scope for the minimum map.
- Sidebar focus management beyond selection (roving tabindex) — none of
  the pinned actions need it.

## Commits

1. `docs(plans): PR #27 keyboard-map plan + INDEX row`
2. `feat(web): keymap module — bindings as data + match guards (pure)`
3. `feat(web): useKeymap + ShortcutOverlay + App wiring`
4. `docs: land PR #27 — rotate plan, CLAUDE/PROGRESS refresh`
