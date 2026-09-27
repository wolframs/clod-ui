# PR #19.1 — Inspection cleanup (post-#19 sweep)

**Status:** Draft (this PR).
**Companion:** This is a sweep PR — no new feature surface, three classes of
hygiene fix surfaced by an inspection pass after PR #19 closed the
streaming-renderer arc.

---

## 1. Why now

After PR #19 the user noted: *taking a step back and admiring the work done so
far as a whole is a good move; maybe one or two bugs or forgotten todos pop
up along the way.* An inspection pass surfaced one real bug and three pieces
of stale-doc drift. Sweeping them in one focused PR before PR #20 (the
`useTranscript` history pane) lands keeps the next slice clean.

---

## 2. Scope

Four fixes, ordered by importance:

1. **Bug fix:** `useSubmitTurn` does not reset its state machine when
   `conv_id` changes. Causes a phantom `submitting` state, a phantom Cancel
   button, a stuck-disabled Send button, and inheritance of error messages
   from the previous conversation when the user switches conversations
   mid-submit.
2. **Plans rotation:** seven landed plans (#16.5, #17, #17.1, #18a, #18b,
   #18c, #19) still in the active `plans/` directory, none listed in
   `plans/INDEX.md`.
3. **`docs/INVARIANTS.md`** out of date in two spots: opening line says
   "PR #1–#16" instead of "PR #1–#19"; I-8 references list `useTurnStream`
   and `useSubmitTurn` as future hooks (both shipped).
4. **`README.md`** says transcript renderer + composer "land next" in
   Phase 4 (PR #18 / #19) — both shipped.

Out of scope (named TODO references, deferred):

- ESC dismisses Composer error block (UX papercut, defer)
- Visual feedback when `handleCancel` fires (UX papercut, defer)
- Architecture v2 plan refresh — already queued for ~PR #20 in `INDEX.md`

---

## 3. Bug detail: `useSubmitTurn` mid-submit conv switch

### Reproducer

1. Click `+ New` → conv A. Type, press Send. Hook flips to
   `state = { status: 'submitting', turn_id: 'turn-A1' }`,
   `lastTurnId = 'turn-A1'`.
2. *While the submit is in flight,* click `+ New` again → conv B.
   `selectedId` flips; `useSubmitTurn`'s `conv_id` prop flips to `convB`.
3. Hook's internal state is unchanged. The Composer for conv B reads
   `submitState.status === 'submitting'` and `lastTurnId === 'turn-A1'`,
   so it renders a phantom Cancel button (the OR-branch in
   `apps/web/src/components/composer.tsx` for "submitting + lastTurnId"
   activates). Send is disabled.
4. If conv A's submit eventually fails, the hook flips state to
   `{ status: 'error', error: ..., attempted_text: 'first message in convA' }`.
   Conv B inherits the error block with conv A's text.

### Fix

Apply the **adjust state on prop change** pattern that `useTurnStream`
already uses (`apps/web/src/lib/use-turn-stream.ts`). When the closure-
observed `conv_id` differs from a tracked ref:

- Reset `state` to `{ status: 'idle' }`.
- Reset `lastTurnId` to `undefined`.
- Reset `inflightRef.current` to `undefined` so any in-flight resolve
  from the previous conv is silently dropped (the `inflightRef === turn_id`
  check in resolve/reject handlers already guards this — clearing the
  ref makes both branches no-op).

The reset must happen *during render* (not in `useEffect`) so the consumer
never observes a frame of the old state under the new `conv_id`. React's
"adjust state during render" pattern handles this — `setState` calls during
render are batched and the render is restarted before commit.

### Regression test

One additional vitest+RTL test in
`apps/web/tests/dom/use-submit-turn.test.tsx`:

> conv_id change resets state + lastTurnId; in-flight resolve from previous
> conv does not clobber the new conv's state.

Sequence:

1. Mount with `conv_id: 'convA'`.
2. Submit; capture the in-flight promise resolver.
3. Re-render with `conv_id: 'convB'`.
4. Assert `state === { status: 'idle' }` and `lastTurnId === undefined`
   *immediately after re-render* (not after a tick).
5. Resolve the captured promise (convA's submit completes).
6. Assert state is *still* `idle` and `lastTurnId` is still `undefined`.
7. Submit again with `conv_id: 'convB'`.
8. Assert `state.status === 'submitting'` and `lastTurnId === 'turn-B1'`.

---

## 4. Plans rotation

`plans/` (active) currently holds:

- `2026-04-23-clod-ui-architecture-v2.md` — living
- `2026-04-23-clod-ui-test-strategy-v1.md` — living
- `2026-04-30-clod-ui-pr16-5-cleanup-v1.md` — landed
- `2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md` — landed
- `2026-04-30-clod-ui-pr17-1-replay-schema-and-reconnect-integration-v1.md` — landed
- `2026-04-30-clod-ui-pr18a-use-subscribe-v1.md` — landed
- `2026-05-01-clod-ui-pr18b-use-turn-stream-v1.md` — landed
- `2026-05-02-clod-ui-pr18c-turn-view-v1.md` — landed
- `2026-05-02-clod-ui-pr19-composer-v1.md` — landed
- `INDEX.md`

Rotate the seven landed plans into `plans/landed/`. Refresh `INDEX.md`:

- Add seven rows to the **Landed** table.
- Drop the now-empty **Active plans** section (or leave with this PR as the
  one entry until it ships).

The convention from PR #16.5 (`plans/INDEX.md:51-52`) says rotate when active
dir approaches ~5 entries; we're at 7 over the threshold.

---

## 5. `docs/INVARIANTS.md` refresh

- Line 3: `These contracts have hardened across PR #1–#16` → `PR #1–#19`.
- I-8 references list (line ~51): drop `useTurnStream` and `useSubmitTurn`
  from the "future hooks" example list since they shipped; mention that
  the pattern continues into `useTranscript` (queued for PR #20).

The eight invariants themselves are still accurate; no contract change.

---

## 6. `README.md` refresh

- Line 41 (`apps/` block): `... transcript renderer + composer land next.`
  → `... transcript renderer + composer all wired.` (or similar — reflect
  the now-shipped state).
- Line 83 (Known gaps): same paragraph with the same staleness. Update or
  remove the bullet entirely (the only remaining gap is `useTranscript`
  for historical messages, which can be a one-line bullet pointing at
  Phase 4's tail).

---

## 7. Test impact

- One new vitest+RTL regression test in `use-submit-turn.test.tsx`.
- All other tests unchanged.

Spine remains 24 / 24 across 14 contracts. ci:fast green.

---

## 8. Deferred (named, not addressed in this PR)

- `// TODO(esc-dismiss-error)` — ESC key in Composer textarea dismisses
  the error block. Defer to PR #20 or later.
- `// TODO(cancel-feedback)` — visual feedback when `handleCancel` fires
  (button briefly disabled, "Cancelling…" copy). Defer.
- Architecture v2 → v3 refresh — queued for ~PR #20 per `INDEX.md`.
