# Clod UI — PR #5 Scope: Cancel Ladder + Error Taxonomy + Concurrent Rejection (v1)

> **Status:** Active. Fourth slice of Phase 2. Depends on PR #4 (merged / staged).
>
> **Reads required:**
>
> - `plans/2026-04-23-clod-ui-architecture-v2.md` §Phase 2 Task 2.5 (cancel ladder), 2.6 (error taxonomy), 2.7 (engine routes)
> - `plans/2026-04-23-clod-ui-test-strategy-v1.md` T1.05, T1.06, T1.07, T1.08, T1.12
> - `plans/landed/2026-04-23-clod-ui-pr4-real-startturn-v1.md` (for slicing precedent)

## Design decision (confirmed by user this session)

`auth_failed` surfaces from the **first real turn**, not from `/health`. Consequence:

- `/health.cli` stays three-valued in practice (`ok` | `missing` | `crashed`). The `unauthenticated` enum value in `HealthCliStatusSchema` is kept as a reserved label for future use but deliberately never reported.
- The two skipped T1.12 cases are not "pending PR #5" — they're architecturally out of scope. PR #5 removes the skipped block and adds an explanatory comment at the top of T1.12.
- Auth failures live in the `turn.error{kind: 'auth_failed'}` error kind, emitted when the CLI's stderr on a failing turn matches auth-failure patterns.

## Scope Note (why this is one PR)

PR #4 slicing established that pure modules + their first wiring make a coherent PR. PR #5 groups the four T1.xx spine tests that share an underlying substrate (subprocess supervision + error classification) plus the engine state needed by T1.08. The commits inside this PR are separable:

1. Pure stderr classifier + unit tests
2. Cancel ladder in `RealClaudeBackend` + shim tests
3. Engine-level concurrent-send rejection + stderr classifier wiring + `cli_crashed` propagation
4. Spine test un-skips (T1.05, T1.06, T1.07, T1.08) + T1.12 cleanup

If any one of these proves larger than expected in implementation, it can be split out — but as designed they compose. The classifier is pure (no I/O), the cancel ladder is a subprocess-level concern, and the engine changes thread both through. Spine tests are the binding.

## Objective

1. **Cancel ladder.** `RealClaudeBackend.cancel(turnId)` sends SIGINT → after `graceTermMs` escalates to SIGTERM → after `graceKillMs` more escalates to SIGKILL. Each escalation hits the subprocess's process group (we already spawn `detached: true`). `startTurn`'s `finally` branch emits a terminal `turn.cancelled{escalation}` envelope instead of `turn.error{cli_crashed}` if cancellation was requested — `escalation` is the highest level actually sent before the process exited.
2. **Stderr classifier.** `packages/backend/src/classify-error.ts` exports `classifyCliFailure({raw_stderr, exit_code, signal?, cli_subtype?}): ClodError`. Pattern-based mapping from stderr lines + CLI result-subtypes (`error_max_turns`, `error_during_execution`, etc.) into `auth_failed` | `rate_limited` | `tool_denied` | `model_unavailable` | `cli_crashed`. Fallback is `cli_crashed` with `raw_stderr` preserved. Runs through both `parseStreamJsonLine`'s result-error branch and `RealClaudeBackend`'s non-zero-exit synthesizer, plus the engine's thrown-iterator catch.
3. **Engine concurrent-send rejection.** A second POST to `/conversations/:id/turns` while a prior turn on the same `:id` is in flight returns `409 {error: {kind: 'conversation_busy', active_turn_id}}`. Test T1.08 asserts both the status code and the typed body shape.
4. **Spine un-skips.** T1.05, T1.06, T1.07, T1.08 become live; T1.12's skipped block is removed (with an explanatory header comment).
5. `bun run ci:fast` green, 10× consecutive, no process leaks.

## Implementation Plan

### Section 1 — Pure stderr classifier (`packages/backend/src/classify-error.ts`)

- [ ] Task 1.1. Export `classifyCliFailure(input: ClassifyInput): ClodError`.
  - `ClassifyInput = {raw_stderr?: string; exit_code?: number; signal?: string; cli_subtype?: string}`
  - Return type is the discriminated union `ClodError` from `@clod-ui/contracts`.
- [ ] Task 1.2. Patterns (case-insensitive, substring unless otherwise noted):
  - `auth_failed`: `not authenticated`, `please run.*claude login`, `unauthor[iz]ed`, `api key`, `credentials`
  - `rate_limited`: `rate limit`, `too many requests`, `429` — when matched, extract `retry_after_ms` from `Retry-After: <seconds>` or `in (\d+)s` if present
  - `tool_denied`: `tool .+ (not allowed|denied|permission)`, `allowedtools` (case-insensitive, token at start of a line only — to avoid false-positives on our own argv)
  - `model_unavailable`: `model .+ not (available|found)`, `unknown model`
  - `cli_crashed` (fallback): everything else. Preserves `exit_code`, `signal`, `raw_stderr`.
  - All non-crash cases preserve `raw_stderr` and `detail` (short one-line summary).
- [ ] Task 1.3. CLI result-subtype mapping (input via `cli_subtype`):
  - `error_max_turns` → `cli_crashed` with `detail: 'conversation exceeded max turns'` (Phase 5 may add a dedicated kind; out of scope here).
  - `error_during_execution` → stderr-classified (pass through to pattern matching)
  - Unknown subtype → `cli_crashed` with `detail` containing the subtype name.
- [ ] Task 1.4. `retryable` per kind:
  - `auth_failed`: `false` (requires user action)
  - `rate_limited`: `true`
  - `tool_denied`: `false`
  - `model_unavailable`: `false`
  - `cli_crashed`: `true`

### Section 2 — Classifier tests (`packages/backend/tests/classify-error.test.ts`)

- [ ] Task 2.1. Case-per-kind table: one realistic stderr snippet per kind, one exit_code, one signal if applicable → asserted `ClodError`. Snippets drawn from defensive reads of the CLI's error messages (today: `--help`'s error handling section + observations from failed probes in prior PRs).
- [ ] Task 2.2. Rate-limit retry_after parsing: `Retry-After: 42` header-style → `retry_after_ms: 42000`; `try again in 12s` → `retry_after_ms: 12000`. Empty stderr → no retry_after.
- [ ] Task 2.3. Priority ordering when multiple patterns match: `auth_failed` wins over `cli_crashed`; `rate_limited` wins over `cli_crashed`; `tool_denied` wins over `cli_crashed`. When `auth_failed` and `rate_limited` both apparently match, `auth_failed` wins (if auth is broken, retry won't help).
- [ ] Task 2.4. Empty stderr + non-zero exit → `cli_crashed` with `exit_code` preserved, no `raw_stderr` field.
- [ ] Task 2.5. Signal termination: `signal: 'SIGTERM'` → `cli_crashed` with `signal: 'SIGTERM'` in the result (used when a turn dies from external kill, not our cancel ladder — the ladder emits `turn.cancelled` instead).

### Section 3 — Cancel ladder in `RealClaudeBackend`

- [ ] Task 3.1. Replace the `active: Map<string, Subprocess>` with an `ActiveTurn` record: `{ proc, cancelRequested, escalation, graceTermTimer?, graceKillTimer? }`. `escalation` is the highest signal sent so far (`null` | `sigint` | `sigterm` | `sigkill`).
- [ ] Task 3.2. Constructor options: `graceTermMs` (default 500), `graceKillMs` (default 500).
- [ ] Task 3.3. `cancel(turnId)`:
  - Look up the active turn. Return silently if not found.
  - Already-requested? Return silently (idempotent).
  - Mark `cancelRequested = true`, `escalation = 'sigint'`, send `SIGINT` to `-proc.pid`.
  - `graceTermTimer = setTimeout(() => { if still active: escalation='sigterm', SIGTERM }, graceTermMs)`
  - `graceKillTimer = setTimeout(() => { if still active: escalation='sigkill', SIGKILL }, graceTermMs + graceKillMs)`
  - Each signal send is wrapped in a try/catch that falls back to direct-child kill if pgid kill throws.
- [ ] Task 3.4. In `startTurn`'s `finally`, clear the two timers. Before the `finally`, if `cancelRequested`, emit `turn.cancelled{escalation}` instead of the synthetic `turn.error{cli_crashed}`. The CLI may also emit a normal `turn.result` or stream-JSON error before being killed — those still win (we respect the stream ordering; only a subprocess exit without any terminator triggers synthesis).
- [ ] Task 3.5. Re-surface `turn.error` classification: the stream-JSON-originated `turn.error` events already come from `parseStreamJsonLine`'s coarse `cli_crashed` fallback; pipe them through `classifyCliFailure` using `{raw_stderr: stderrChunks.join(''), cli_subtype: lastResultSubtype}`. The non-zero-exit synthesizer also runs through the classifier. The `parseStreamJsonLine` module itself remains pure; the classifier invocation happens at the callsite in `real.ts`.

### Section 4 — Cancel-ladder shim tests (`packages/backend/tests/real.test.ts`, new describe)

- [ ] Task 4.1. Shim helpers:
  - `writeIgnoringShim`: drains stdin, `trap '' INT TERM` (ignores SIGINT + SIGTERM), emits a marker init line, sleeps `<ignoreMs>`, then exits (or gets SIGKILL'd).
  - `writeHonorsSigintShim`: drains stdin, emits marker init, `trap 'exit 0' INT`, sleeps, exits.
  - `writeHonorsSigtermShim`: drains stdin, emits marker init, `trap '' INT`, default SIGTERM, sleeps.
- [ ] Task 4.2. Cases (timeouts explicitly scoped via `test(name, fn, timeoutMs)` to survive parallel load):
  - Honors SIGINT: cancel → SIGINT sent, process exits quickly, `turn.cancelled.escalation === 'sigint'`.
  - Ignores SIGINT, honors SIGTERM: cancel → SIGINT ignored, after `graceTermMs` SIGTERM sent and honored, `turn.cancelled.escalation === 'sigterm'`.
  - Ignores SIGINT + SIGTERM: cancel → SIGKILL reached after `graceTermMs + graceKillMs`, `turn.cancelled.escalation === 'sigkill'`.
  - Cancel before spawn: call `cancel(t)` before `startTurn` — silent no-op (no crash, no envelope).
  - Double-cancel is idempotent: two `cancel(t)` calls yield a single ladder run.

### Section 5 — Engine: concurrent-send rejection (`apps/engine/src/index.ts`)

- [ ] Task 5.1. Track `activeTurnByConv: Map<convId, turnId>` alongside the existing `activeTurns: Map<turnId, convId>`. Insert on POST /turns acceptance; delete in the streaming `finally`.
- [ ] Task 5.2. On POST /turns, if `activeTurnByConv.has(convId)`: `409 {error: {kind: 'conversation_busy', active_turn_id: <string>}}`. Do not mutate state. Return.
- [ ] Task 5.3. The engine's streaming catch block (around `for await backend.startTurn`) routes any thrown iterator error through `classifyCliFailure({detail: err.message})` before wrapping it into a `turn.error`. That way T1.07's `ChaosBackend` throw yields a `cli_crashed` envelope with the chaos message as `detail`.
- [ ] Task 5.4. The `AppContext` gains nothing new; the concurrent-send state is engine-private. The typed error body is a new ad-hoc shape — document in the route handler's comment that if this ever becomes a wire-visible error kind, it should be added to `ClodError` contract in a dedicated PR.

### Section 6 — Engine tests (new file: `apps/engine/tests/routes.test.ts`)

- [ ] Task 6.1. `POST /turns` with invalid body → 400 (already works).
- [ ] Task 6.2. `POST /turns` with valid body + no active turn → 202, `accepted: true`.
- [ ] Task 6.3. `POST /turns` twice on the same conv back-to-back (before the first stream finishes) → first 202, second 409 with typed body. Uses a `ChaosBackend(ScriptedBackend(…), { startupDelayMs: 300 })` to keep the first turn pending long enough to exercise the race.
- [ ] Task 6.4. `POST /turns` on one conv, then on a *different* conv → both 202 (concurrency is cross-conv, not cross-engine).

### Section 7 — Spine un-skips

- [ ] Task 7.1. **T1.05** cancel ladder (`tests/spine/T1.05-cancel-ladder.test.ts`):
  - Use `ChaosBackend(ScriptedBackend(…), { refuseSigtermFor: 750 })` to model a subprocess that ignores SIGINT + SIGTERM for 750ms. Submit turn, cancel, assert terminal envelope is `turn.cancelled{escalation: 'sigkill'}` (with `graceTermMs + graceKillMs < 750`). The Chaos decorator doesn't actually receive OS signals — the test exercises the engine-level escalation contract via the scripted refusal semantics, not real subprocess signal handling. The **real-subprocess** cancel ladder is exercised by §4's shim tests; this spine test exercises the envelope-level contract.
  - `expectNoZombies(env)` passes (no real subprocess in a chaos-only test, trivially true).
- [ ] Task 7.2. **T1.06** cancel before first event:
  - `ChaosBackend(ScriptedBackend(init + assistant + result), { startupDelayMs: 2_000 })`. Submit turn, cancel at +100ms. Assert terminal envelope is `turn.cancelled` within 500ms, no other events emitted.
  - `expectNoZombies(env)`.
- [ ] Task 7.3. **T1.07** crash mid-stream:
  - `ChaosBackend(ScriptedBackend(4 deltas + result), { crashAfterEvents: 3 })`. Submit turn, await the terminal envelope. Assert: first 3 assistant.delta + 1 turn.error{kind: 'cli_crashed', retryable: true}, no more.
  - `expectNoZombies(env)`.
- [ ] Task 7.4. **T1.08** concurrent send rejected:
  - Stand up engine in-process. `ChaosBackend(…, { startupDelayMs: 500 })`. POST turn 1, POST turn 2 immediately. Assert turn 2 is `409` with `error.kind === 'conversation_busy'` and `error.active_turn_id === turn1.turn_id`.

### Section 8 — T1.12 cleanup

- [ ] Task 8.1. Remove the `describe.skip('T1.12 health and readiness (pending PR #5 ...)')` block.
- [ ] Task 8.2. Add a header comment at the top of T1.12 noting the design decision: `/health` does not report `unauthenticated` because auth state is not probeable without a real turn; `auth_failed` surfaces from the first real turn per architecture §2.6.

### Section 9 — Verification

- [ ] Task 9.1. `bun run ci:fast` green.
- [ ] Task 9.2. 10× consecutive `ci:fast`, zero flakes.
- [ ] Task 9.3. Post-run `ps` check — no `bun run apps/engine` or `claude` survivors sharing our pgid.
- [ ] Task 9.4. Commit in 4 logical chunks matching §1+§2, §3+§4, §5+§6, §7+§8.

## Out of Scope (explicitly)

- **SQLite + manifest persistence** (T1.01 persistence half, T1.03, T1.10) → PR #6.
- **Transcript watcher** (T1.11) → PR #7.
- **Settings IO** (T1.09) → PR #8.
- **Pidfile + single-instance lock + zombie sweep** → moved to PR #6 (natural pairing with SQLite/manifest since both touch app-state-dir bootstrap).
- **Retry UX** — the `retryable` flag is surfaced but the engine does not auto-retry; that's a client-side concern.
- **Fine-grained rate-limit header parsing** — we do a cheap regex pass. A full HTTP-header parser lives behind a flag if we ever need it.
- **Adding `conversation_busy` to `ClodError`** — PR #5 keeps it engine-local per the scope note. If later PRs find it useful wire-side, a schema-bump PR lifts it.

## Risks

1. **Signal propagation under Bun.** `detached: true` + `process.kill(-pgid, sig)` was verified working in PR #4. SIGINT in particular: bash with `trap` can ignore SIGINT, but `sleep` itself dies on SIGINT in most shells. Our shim tests use explicit `trap '' INT` / `trap '' TERM` to make the ladder behavior deterministic rather than relying on default bash behavior.
2. **Test-timing under load.** Cancel-ladder shim tests spawn subprocesses and rely on timer escalation; the PR #4 precedent was to give cancel-related tests explicit 15s timeouts and synchronize on marker events rather than fixed `setTimeout`. PR #5 follows the same pattern. Default `graceTermMs`/`graceKillMs` of 500ms each keep the test budget within 2–3s per case.
3. **ChaosBackend doesn't receive OS signals.** T1.05 exercises the envelope-level contract only; real signal-handling is covered by §4 shim tests. This is a deliberate separation and documented in T1.05's body comment.
4. **Classifier pattern fragility.** Anthropic may change stderr wording. Mitigation: the classifier is pure, unit-tested, and a single module — a future PR can upgrade to a more structured parse when/if the CLI gains a stable error-code surface. Fallback to `cli_crashed` with `raw_stderr` preserved means the UI never drops information.

## Open Items

- **PR description** should call out the design decision that `unauthenticated` is a deliberate non-state at `/health`.
- **Follow-up plan file** for PR #6 (SQLite + manifest + pidfile + T1.01 completion) drafted once this PR merges.
- **No schema bump** needed for this PR — `ClodError`, `HealthResponse`, and `BackendEvent.turn.cancelled` all already carry the shapes we need.
