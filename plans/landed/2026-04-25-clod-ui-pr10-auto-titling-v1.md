# PR #10 — Auto-titling foundation

**Status:** Implementation
**Spec:** `plans/2026-04-23-clod-ui-architecture-v2.md` Task 3.5
**Depends on:** PR #6 (manifest), PR #9 (ChatMessage normalization not strictly required, but the wire-event pattern from PR #7 is reused)

## Charter

Conversations get titled automatically after the first `turn.result`, so the
sidebar is scannable without user effort. The architecture spec is:

> after the first `turn.result`, dispatch a secondary headless `claude -p`
> with a minimal prompt asking for a 4–6 word title; on failure or timeout,
> fall back to a date+first-words title. **Failure is non-fatal.**

This PR lands the **foundation**:

- The new manifest event kind `conversation.titled { title }` and its fold rule.
- The `Titler` interface and a `FallbackTitler` (date+first-words) that ships
  as the default. The deterministic fallback **is** the spec's failure path,
  so it is independently shippable: even before the LLM titler exists, every
  conversation gets a title.
- The engine wiring: detect first `turn.result` for a titleless conversation,
  dispatch the titler, append the manifest event, broadcast a wire envelope.

The LLM-backed `DefaultTitler` (the `claude -p` invocation, stderr
classification, budget enforcement) is **explicitly deferred** to PR #11.
Splitting along the seam keeps each slice the size of PR #9.

## Non-goals (in this PR)

- **`claude -p` invocation.** Deferred to PR #11. The `Titler` interface in
  this PR is shaped so swapping in `DefaultTitler` is a one-line wiring change.
- **Re-titling.** Once `state.title` is set in the manifest fold, the engine
  never overwrites it — even if the user explicitly retitles via UI later
  (that's a different event, not this one). YAGNI for now.
- **SQLite `title` column.** The projection already lives in
  `ConversationState.title` from the fold. Materializing into SQLite happens
  the day a sidebar HTTP route lands (Phase 4); doing it now is YAGNI and the
  schema migration carries cost.
- **Manual title edit endpoint.** No `PUT /conversations/:id/title` route in
  this PR — when Phase 4 needs it, it's a one-liner that appends a
  `conversation.titled` event with `source: 'user'`. The schema is forward-
  compatible.

## Design

### Wire taxonomy

A new wire event kind `conversation.titled` flows through the same
`wrap()` plumbing as `BackendEvent` and `TranscriptUpdatedEvent`. Its
payload:

```ts
{
  kind: 'conversation.titled';
  conv_id: string;
  title: string;
}
```

`wrap()` widens its event-type union by one. The envelope's `kind` and
`conv_id` are populated as for any other event; `payload` carries the
typed `ConversationTitledEvent`.

### Manifest taxonomy

```ts
| { kind: 'conversation.titled'; title: string }
```

Fold:

```ts
case 'conversation.titled':
  state.title = ev.title;
  break;
```

`conversation.created.title` already exists (a manual title supplied at
creation time). The fold ordering is "last-write-wins" — but the engine
**never** writes `conversation.titled` if `state.title` is already set, so
in practice the manual title from `conversation.created` always wins.

Idempotency invariant: at most one `conversation.titled` event per
conversation ever ships from auto-titling.

### Titler interface

```ts
export interface TitlerInput {
  conv_id: string;
  user_message: string;
  /** Accumulated assistant text from the just-finished turn. May be empty. */
  assistant_text: string;
  /** Wall-clock timestamp of the turn.result. Used by the fallback. */
  ts: number;
}

export interface Titler {
  suggestTitle(input: TitlerInput): Promise<string>;
}
```

The contract:

- The titler **always** returns a non-empty string. Internal failures are
  the titler's problem; callers never have to handle a titler error.
- `FallbackTitler` is the canonical implementation for this PR.
- `DefaultTitler` (PR #11) wraps an LLM call; on timeout/error/empty, it
  internally delegates to `FallbackTitler` and still returns a non-empty
  string.

### `FallbackTitler` derivation rule

Given `(user_message, ts)`:

1. Trim `user_message`.
2. Take the first sentence (split on `.`, `!`, `?`, newline, whichever comes
   first; fall back to whole string).
3. Take the first 8 words. Cap each word at 24 chars.
4. Cap the joined string at 80 chars (the manifest doesn't enforce this, but
   the UI sidebar will truncate visually anyway).
5. If the result is empty, use `Conversation @ <YYYY-MM-DD HH:MM>` derived
   from `ts`.

Deterministic, no I/O, no async. Easy to test with table-driven cases.

### Engine wiring

`createApp` gains an opt-in option:

```ts
interface CreateAppOptions {
  // ...
  titler?: Titler; // requires persistence
}
```

Without `titler`, no auto-titling fires (matches the existing opt-in pattern
for `transcripts` and `settings`). The engine **does not** instantiate a
default titler when persistence is configured but `titler` is absent — the
production entrypoint wires the default explicitly.

Per-turn assistant-text accumulator (in-memory, keyed by `turn_id`):

```ts
const turnAssistantText = new Map<string, string>(); // turn_id → accumulated
```

State machine inside the per-turn iterator:

- On `assistant.delta`: append `ev.text` to `turnAssistantText.get(turn_id)`.
- On `turn.result` (or any terminator: `turn.cancelled`, `turn.error`):
  - If `titler && persistence`:
    - Read the manifest, fold, check `state.title`. If unset, dispatch the
      titler in a fire-and-forget IIFE.
    - Inside the IIFE: await `titler.suggestTitle(input)`, **re-read** the
      manifest, **re-check** `state.title` (a concurrent UI title-set could
      have raced; correctness requires a second read). If still unset,
      append `conversation.titled` and broadcast.
  - Clean up `turnAssistantText.delete(turn_id)`.

The double-check pattern is borrowed from `recordSessionId` (PR #6) and is
the standard idempotency guard for fire-and-forget engine work.

### Why fire-and-forget

Auto-titling is non-blocking, non-fatal background work. The user's primary
turn must complete and stream its envelopes regardless of titler latency or
failure. The engine's HTTP response (202 Accepted) and the WS event flow are
already decoupled from the titler.

If the engine restarts after `turn.result` but before the titler IIFE
completes, the title is lost. Recovery: on the next turn for that conversation,
the same logic fires again (state.title is still unset) and a fresh title is
generated. No persistent "titling pending" state needed.

### Cancel/error semantics

A turn that ends in `turn.cancelled` or `turn.error` still triggers titling
**iff** there is a non-empty `user_message`. The user's intent ("ask about
X") survives even if the model didn't get to answer; the title will derive
from the user's message via the fallback path. This is mild over-fidelity to
the spec ("after the first `turn.result`") but matches the spirit ("scannable
sidebar without user effort"). The unit test covers this case explicitly.

### Wire envelope

```ts
{
  v: 1,
  id: '<envelope-id>',
  ts: Date.now(),
  kind: 'conversation.titled',
  conv_id: '<convId>',
  payload: {
    kind: 'conversation.titled',
    conv_id: '<convId>',
    title: '<title>',
  },
}
```

Subscribers diff on `kind === 'conversation.titled'` and update their
sidebar entry. Late WS subscribers re-fetch the conversation list (Phase 4
HTTP route) which folds the manifest and surfaces the title that way.

### Production entrypoint

The default config wires `FallbackTitler` (until PR #11 swaps in
`DefaultTitler`):

```ts
const titler = new FallbackTitler();
const liveContext = createApp({
  backend, store, db,
  // ... transcripts, settings ...
  titler,
});
```

PR #11 will change this single line to `new DefaultTitler({...})`.

## Tests

### Manifest unit tests (`packages/manifest/tests/store.test.ts`)

Extend the existing fold test:

- `conversation.titled` updates `state.title`.
- `conversation.created.title` followed by `conversation.titled` → fold
  ends with the second title (last-write-wins at the fold layer; the engine
  enforces the higher-level "first wins" invariant by *not appending*).

### Titler unit tests (`apps/engine/tests/titler.test.ts`)

Table-driven for `FallbackTitler.suggestTitle`:

- 8-word cap (long input)
- First-sentence split on `.`, `!`, `?`, newline
- 24-char word cap
- Empty / whitespace-only input → date-stamped fallback
- Trim leading/trailing whitespace
- Multi-line input (only first line considered, modulo sentence split)
- Determinism: same input twice → same output

### Engine integration tests (`apps/engine/tests/auto-titling.test.ts`)

Boot pattern matches `provisioning.test.ts` + `settings-routes.test.ts`:
real `createApp` with persistence + `ScriptedBackend` + a custom `Titler`.

Cases:

1. **Happy path**: titleless conversation gets a title after first
   `turn.result`. Verify (a) titler was called once with correct input,
   (b) manifest now contains a `conversation.titled` event with the
   returned title, (c) wire broadcast fired with the same title.
2. **Idempotency under restart**: after the first `turn.result` titles the
   conversation, a *second* turn does **not** re-trigger the titler.
   Verify titler was called exactly once total.
3. **Concurrent UI retitle race**: titler's promise is in flight; we
   simulate a UI write (append `conversation.titled` directly to manifest).
   When the titler resolves, the engine re-reads, sees a title is already
   set, and **does not** double-append.
4. **No persistence ⇒ no titling**: opt-in option absent, no titler call
   even when one is configured. (Covered by the option-validation rule.)
5. **No titler ⇒ no titling**: persistence on, titler off, normal turn
   completes without title write. (Sanity check that the option is
   actually opt-in.)
6. **Title broadcast carries `conv_id`**: envelope has the right `conv_id`
   so multi-conversation UIs can route correctly.

### What we don't test in this PR

- LLM titler timeout / classification — that's PR #11's surface.
- Re-titling via UI endpoint — no such endpoint exists yet.
- SQLite title column population — the column doesn't exist.

## What unblocks next

- **PR #11 — `DefaultTitler` (claude -p)**: swap the production entrypoint's
  `FallbackTitler` for a `DefaultTitler` that spawns `claude -p`, applies
  a 5s budget, classifies stderr, and falls back internally.
- **Phase 4 sidebar route**: `GET /conversations` returns a list with each
  conv's projected title. Folding is already cheap (microseconds per
  manifest); no SQLite migration needed yet, but if the sidebar render hot
  path demands it, that PR will add the column + migration.
- **Manual retitle endpoint** (`PUT /conversations/:id/title`): when the UI
  needs an "edit title" affordance, it appends `conversation.titled` with
  the new title. The "first auto-title wins" invariant is still preserved
  in the auto-titling code path (the `state.title` check); manual edits go
  around it.

## Summary

This PR delivers the **complete auto-titling lifecycle** (trigger detection,
title derivation, manifest persistence, wire broadcast, idempotency) using
a deterministic fallback titler. Subsequent PRs swap in smarter titling
strategies without re-touching any wiring. The "every essential behavior is
covered by an executing test" milestone holds: spine still 20/20, plus 6
new engine integration tests over the auto-titling lifecycle and 7+ unit
tests over `FallbackTitler`.
