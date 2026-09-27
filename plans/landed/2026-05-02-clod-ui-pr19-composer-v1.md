# PR #19 — Composer (the loop closes)

**Date:** 2026-05-02
**Phase:** 4 (Web UI scaffolding)
**Architecture task:** 4.5 (Composer)
**Spine impact:** none (UI-tier; no new wire shapes)

## 1. Why this PR exists

PR #18a (`useSubscribe`) → PR #18b (`useTurnStream`) → PR #18c (`TurnView`)
gave the streaming arc its data, projection, and pixels. What's still
missing is the part where the user can *put their own voice into the
wire.* Today, the only way to drive a turn is to hit `POST
/conversations/:id/turns` from a terminal — the UI can render anything
that arrives, but it cannot speak.

PR #19 closes that loop. After this slice lands, a user can:

1. Open the web app
2. Click "+ New" in the sidebar to create a fresh conversation
3. Type a message in the Composer
4. Press Enter (or click Send) to submit the turn
5. Watch the streaming response render through `TurnView`
6. Press Cancel mid-stream to escalate the cancel ladder

The end-to-end loop the project has been building toward.

## 2. Scope

In:

- `useSubmitTurn` hook — wraps `client.submitTurn`; exposes
  `{ submit, state }` with discriminated `state ∈ { idle | submitting |
  error }`. Generates `turn_id` per submit.
- `Composer` component — pure-ish: owns the textarea state locally,
  takes `convId` + `activeTurnId` + `turnStatus` + `onSubmit` +
  `onCancel` as typed props. Renders Send when idle/streaming-completed;
  renders Cancel when streaming.
- `Sidebar` gains an optional `onNew?: () => void` prop. When provided,
  renders a "+ New conversation" button at the top of the sidebar.
- `App.tsx` wires both:
  - Generates a fresh UUID via `crypto.randomUUID()` on `onNew`, sets
    `selectedId` to the new value (the sidebar will still show the
    pre-existing list; the new conv will appear after the first turn
    completes and the sidebar refreshes — defer auto-refresh-on-broadcast
    to PR #19.5 or beyond).
  - Renders `<Composer>` below `<TurnView>` when a conv is selected.

Out:

- Markdown rendering in `AssistantMessage` — queued for PR #18d
- Tool-card collapsibles — queued for PR #18d
- Scroll-to-bottom — queued for PR #18d / PR #20
- Live-refresh sidebar on `conversation.titled` — queued for PR #19.5
- Multi-line paste / drag-drop attachments — queued for PR #21
  (attachments are Phase 6 territory)
- Model picker / system prompt editor / thinking effort chips — those
  are Phase 5 (controls)
- Optimistic user-message rendering before `system.init` arrives — the
  current scope shows the user's text in the textarea until the first
  envelope arrives; "echo the user message into TurnView" is queued for
  PR #20 (`useTranscript` history) since that's where the user-message
  visual surface lives.

## 3. Wire shapes (no new ones)

Reuses existing surfaces:

- `client.submitTurn({ conv_id, turn_id, user_message })` (PR #13)
- `client.cancelTurn({ conv_id, turn_id })` (PR #13)
- `useTurnStream` (PR #18b) for `activeTurnId` / `turnStatus`

The Composer is a pure consumer of the typed-client surface. Zero
contract changes.

## 4. The submit + cancel state machine

```
        ┌─────────────────────────────────────────────────┐
        │                  Composer state                 │
        │                                                 │
        │  empty textarea                                 │
        │       │                                         │
        │       ↓ user types                              │
        │  has text                                       │
        │       │                                         │
        │       ↓ Enter / Send click                      │
        │  submitting (network call in flight)            │
        │       │                                         │
        │       ├─ submitTurn resolves → idle (cleared)   │
        │       └─ submitTurn rejects → error (text kept) │
        │                                                 │
        │  After idle, useTurnStream takes over:          │
        │       streaming → Cancel button enabled         │
        │       completed/cancelled/errored → Send only   │
        │                                                 │
        └─────────────────────────────────────────────────┘
```

Composer's local state: `{ text: string }`.
useSubmitTurn's state: `{ status: 'idle' | 'submitting' | 'error', error? }`.
Cancel-button visibility: derived from `turnStatus === 'streaming'`.

The Composer never tracks `turnId` itself — the active `turnId` flows
in via props from the TurnView's parent (App), which reads it from
`useTurnStream`'s `state`.

## 5. UX rules

- **Enter submits, Shift+Enter inserts newline.** Standard chat-app
  convention; tested explicitly.
- **Empty / whitespace-only submits are no-ops.** The Send button is
  disabled when the textarea is empty/whitespace.
- **Submit clears the textarea.** Even if the user is fast and types
  while submitting, the textarea clears on `submit` invocation, not on
  resolution.
- **Submit errors keep the text.** If the network call rejects, the
  text stays in the textarea (and an error message renders below it)
  so the user can retry without losing what they typed.
- **Cancel is disabled when no turn is streaming.** The button is
  visible only when `turnStatus === 'streaming'`; clicking calls
  `client.cancelTurn` with the active `turn_id`.
- **Disabled when no conversation selected.** The Composer renders a
  hint ("Select or create a conversation to start") when `convId` is
  absent. Both buttons hidden.

## 6. Component contract (markers per I-3)

```tsx
<form data-test="composer" data-state={state.status}>
  <textarea
    data-test="composer-input"
    aria-label="Message"
    value={text}
    onChange={...}
    onKeyDown={...}
  />
  {error && <p data-test="composer-error" role="alert">{error}</p>}
  <div>
    <button
      data-test="composer-cancel"
      type="button"
      hidden={turnStatus !== 'streaming'}
      onClick={onCancel}
    >
      Cancel
    </button>
    <button
      data-test="composer-send"
      type="submit"
      disabled={!text.trim() || state.status === 'submitting'}
    >
      Send
    </button>
  </div>
</form>
```

## 7. Test plan

- `apps/web/tests/composer.test.tsx` (renderToString) — ~10 tests:
  - empty-text initial state
  - error variant shows error block
  - submitting variant disables Send
  - hint shown when no convId
  - Cancel button visible only when turnStatus === 'streaming'
  - Send button disabled on empty/whitespace text
- `apps/web/tests/dom/use-submit-turn.test.tsx` (vitest+RTL+happy-dom)
  — ~6 tests:
  - submit calls `client.submitTurn` with a fresh `turn_id` UUID
  - status 'submitting' during call, 'idle' on resolve
  - status 'error' on reject, error message preserved
  - second submit generates a different `turn_id`
  - input includes optional fields when provided
- `apps/web/tests/dom/composer.test.tsx` (vitest+RTL+happy-dom) — ~6 tests:
  - typing updates value
  - Enter submits; Shift+Enter inserts newline
  - submit calls onSubmit with the trimmed text and clears textarea
  - empty text submission is a no-op
  - Cancel click calls onCancel with the active turnId
  - error from useSubmitTurn surfaces visibly

Total new tests: ~22.

## 8. Deferred TODOs (clean & named)

- `// TODO(optimistic-user-echo)` — render the user's message in
  TurnView before `system.init` arrives; queued for PR #20 since
  history rendering is where user-message visuals live.
- `// TODO(sidebar-live-refresh)` — refresh sidebar on
  `conversation.titled` broadcasts so a freshly-created conv appears
  in the list without manual reload; queued for PR #19.5.
- `// TODO(input-history)` — Up-arrow recall of previous messages;
  queued for Phase 5.
- `// TODO(slash-commands)` — `/clear`, `/model`, `/help`; Phase 5.
- `// TODO(streaming-input-disable)` — option to disable input while a
  turn is streaming; deferred until UX preference surfaces (Claude
  Code permits stacked turns; we'll respect that default).

## 9. Risks

- **`crypto.randomUUID()` browser support** — available in all
  evergreen browsers (Chrome 92+, Firefox 95+, Safari 15.4+). Older
  browsers would need a polyfill; we don't ship to them.
- **Clearing-on-submit can race with submit failure** — by design.
  The retry affordance is "your text is in `state.error.attemptedText`,
  paste it back manually." For PR #19 we keep it simple: if submit
  fails, the textarea retains the value (we clear *after* the network
  call resolves, not before). Optimistic clearing is a future toggle.
- **Cancel before first envelope** — the engine handles this correctly
  (covered by spine T1.06). The Composer just needs the `turnId`,
  which `useTurnStream` only knows once `system.init` arrives. Solution:
  Composer also tracks the most-recently-submitted `turnId` locally and
  passes it to `cancelTurn` if `useTurnStream` hasn't seen `system.init`
  yet. Tested.

## 10. Commit plan

1. `docs(plans): PR #19 — Composer (the loop closes)`
2. `feat(web): useSubmitTurn — typed submit with state machine`
3. `feat(web): Composer + Sidebar.onNew — input surface + new-conv affordance`
4. `feat(web): wire Composer + new-conv flow into App.tsx`
5. `test(web): Composer + useSubmitTurn render variants + lifecycle (~22)`
