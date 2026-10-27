# PR #35 — Phase 6b: attachments orphan sweeper (completion goal S10)

Date: 2026-06-12. Spec: completion goal S10. Substrate: attachments
land in `<conv dir>/attachments/` (PR #33); once a turn is sent the
image bytes live in the transcript as base64 — the on-disk file's only
ongoing consumers are tool-driven reads (by path/name) and the serving
route. Files uploaded but never sent are the orphan population.

## Pinned decisions

- **D1 — reference semantics (the load-bearing pin).** A file is
  *referenced* iff its file name appears anywhere in the conversation's
  transcript JSONL text (covers tool Reads, path mentions, and any
  future shape — substring match over raw text is deliberately the
  most conservative practical test). No transcript ⇒ nothing is
  referenced ⇒ only the grace window protects files (covers
  upload-then-never-sent in a fresh conversation).
- **D2 — grace window.** Files with mtime within `graceMs` (default
  24 h) are always kept — protects uploads awaiting their first send
  and absorbs clock skew. Conservative by default: referenced OR
  recent ⇒ keep.
- **D3 — pure plan, thin shell.** `planSweep({ files: Array<{ name,
  mtime_ms }>, transcriptText, now_ms, graceMs })` → `Array<{ name,
  action: 'keep' | 'delete', reason: 'referenced' | 'recent' |
  'orphan' }>` — fixture-tree unit tests are tables over this. The
  shell gathers inputs (readdir + stat + readAllLines raw text) and
  acts.
- **D4 — I-5 double-check before every unlink.** Plan → re-stat the
  file → re-check (mtime unchanged AND name still unreferenced in a
  freshly read transcript) → unlink. Any step failing ⇒ spare the
  file. Failures log-only; the worker never throws into the engine.
- **D5 — dry-run default-on; deletion is double opt-in.**
  `createApp({ sweeper: { dryRun?: boolean = true, graceMs?, } })` —
  option absent ⇒ no sweeper at all. One pass at boot over provisioned
  conversations, fire-and-forget. Production: env `CLOD_UI_SWEEPER` —
  unset ⇒ off; `dry-run` (or `1`) ⇒ logs what it *would* delete;
  `delete` ⇒ real deletions. No interval; `TODO(sweeper-interval)`.
- **D6 — no spine.** Exit criteria are unit-level: pure plan tables +
  a shell test against real temp trees (dry-run deletes nothing;
  delete-mode removes orphans only; the double-check spares a file
  touched between plan and act). Deletion never gates a wire behavior.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Pure core:** `apps/engine/src/sweeper.ts` — `planSweep` + the
   `sweepConversation` shell + `runSweeper` (all-conversations pass) +
   unit tests (plan tables; shell over fixture trees; double-check
   race test via mtime bump).
3. **Wiring:** createApp option (boot-time fire-and-forget, gated on
   persistence) + production env mapping + log lines.
4. **Docs:** CLAUDE/PROGRESS/goal S10 ✅, rotate plan, INDEX,
   NEXT-SESSION (S11 next — ci:deep).

## Deferred (named)

- `TODO(sweeper-interval)` — periodic re-sweep; boot-pass only today.
- Scratch-dir sweeping — `scratch/` has no reference semantics yet;
  out of scope (named, not silent).

## Commits

1. `docs(plans): PR #35 orphan-sweeper plan + INDEX row`
2. `feat(engine): planSweep + double-checked sweep shell (pure core + tests)`
3. `feat(engine): sweeper wiring — boot pass behind explicit option, dry-run default`
4. `docs: land PR #35 — rotate plan, refresh`
