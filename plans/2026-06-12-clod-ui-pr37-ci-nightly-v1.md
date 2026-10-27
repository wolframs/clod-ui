# PR #37 — ci:nightly de-stubbing: tapes + live smoke (completion goal S12)

Date: 2026-06-12. Spec: completion goal S12; test-strategy L1/L6.
Substrate: `recordTape` + `TapeBackend` (PR #1) exist;
`tests/fixtures/cli-tapes/` is empty; `runNightly` is runDeep + a TODO
log; `nightly.yml` exists.

## Evidence gathered up front (CLI 2.1.175)

- `--effort` accepts **low, medium, high, xhigh, max** (`--help` text);
  an invalid value is **warned and ignored**, not rejected — observed
  directly. Two consequences: (1) `THINKING_EFFORT_MAP` emits only
  valid values but `xhigh` is unreachable from our enum — extend it;
  (2) our 400-on-unknown wire stance (PR #24 D3) is *stricter than the
  CLI's own laxness*, which is exactly the expose-the-wire posture —
  record that, change nothing.
- **Spend note:** the probe cost one unintended default-model turn
  (the CLI ran the prompt instead of erroring). Counted against the
  sparing budget; future probes are `--help`-only.
- Latent recorder bug (PR #1 era): `recordTape` composes
  `-p --output-format stream-json --input-format stream-json` without
  `--verbose`, which the CLI requires for that combination (pinned in
  compose.ts since PR #3). Fix before recording.

## Pinned decisions

- **D1 — enum extension, evidence-cited.** `ThinkingEffortSchema` gains
  `'xhigh'` mapping to `--effort xhigh`; `EFFORT_OPTIONS` gains an
  "Xhigh" segment between Think harder and Ultrathink. The name is the
  CLI's own level — no invented synonym. Existing mappings untouched
  (no silent remap).
- **D2 — recorder fix + one tape.** Add `--verbose` to `recordTape`
  (inspection moment). Record **one** tape: haiku, prompt "Reply with
  exactly: ok" (the L1 contract is stream-json line shapes, one good
  tape covers the pipeline). Checked into `tests/fixtures/cli-tapes/`.
  Recording failure twice ⇒ stop, repro in NEXT-SESSION (constraint 3).
- **D3 — hermetic tape replay test** in `tests/nightly/`:
  `TapeBackend(tape)` → `createApp` → one turn → assert the wire
  envelopes (init session id, assistant text, `turn.result` last) match
  the tape. Fast/deep bun tiers exclude `tests/nightly/**` (the e2e
  precedent); nightly runs `bun test tests/nightly` explicitly.
- **D4 — flake shuffle** = `bun test --rerun-each=2` over the standard
  unit suite (deterministic-double-run; catches order/state leakage,
  the practical core of "shuffle").
- **D5 — live smoke behind a loud env guard.** `tests/smoke/live-smoke.ts`:
  requires `CLOD_UI_NIGHTLY_LIVE=1` else prints SKIP loudly and exits 0.
  When live: boots the production engine on a temp app-data dir, POSTs
  one haiku text turn ("Reply with exactly: ok"), asserts a `result`
  outcome via `GET /diagnostics`, tears down. One real turn per nightly
  run, by explicit opt-in only. `nightly.yml` does NOT set the guard
  (no CLI auth in CI) — the skip is the loud kind.
- **D6 — runNightly:** runDeep → tape replay (`bun test tests/nightly`)
  → flake shuffle → live smoke script. Exit codes propagate.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Contracts:** enum + map + UI segment + test updates (D1).
3. **Recorder fix + record the tape** (real spend: one haiku turn).
4. **Nightly tier:** tape-replay test + live-smoke script + runNightly +
   tier exclusions + nightly.yml note.
5. **Docs:** counts, CLAUDE/PROGRESS/goal S12 ✅ (effort question
   settled), rotate plan, INDEX, NEXT-SESSION (S13 next).

## Commits

1. `docs(plans): PR #37 ci-nightly plan + INDEX row`
2. `feat(contracts,web): xhigh thinking effort — vocabulary pinned by CLI evidence`
3. `fix(test-kit): recordTape needs --verbose; record the first contract tape`
4. `feat(ci): ci:nightly runs tapes, flake shuffle, and the guarded live smoke`
5. `docs: land PR #37 — rotate plan, refresh`
