# Clod UI — Automated Integration Test Strategy

## Objective

Define a layered, test-first automated testing strategy for clod-ui that gives us **high confidence in the timing- and IO-sensitive parts of the system** (subprocess lifecycle, streaming event ordering, session resume, cancellation, filesystem effects, settings round-tripping, transport-agnostic UI behavior) **before** the production code that implements them is written. Spine tests are authored first and act as the executable specification of the engine's contract; feature tests follow per phase; chaos and performance budgets gate releases.

## Architectural Premises (locked in this iteration)

- **Daemon + SPA architecture.** `@clod-ui/engine` (Bun + Hono) is a local HTTP+WebSocket server; `@clod-ui/web` (Vite + React + TS) is a browser SPA that talks to it via a typed client generated from `@clod-ui/contracts` (Zod schemas + TS types). Same API surface for `localhost`, future LAN, future remote.
- **Per-conversation cwd + append-only manifest.** Each conversation owns `<app-data>/conversations/<uuid>/{cwd,scratch}` and a `manifest.json` event log. State is the fold; tests assert against both the projected state and the underlying event log.
- **`ClaudeBackend` is an interface.** The real implementation spawns `claude -p`. The test implementations are: (a) **TapeBackend** that replays recorded NDJSON; (b) **ScriptedBackend** that emits programmatically-defined event sequences; (c) **ChaosBackend** that decorates either of the above with controllable faults (delays, kills, partial writes).
- **Transport-agnostic tests.** Integration tests drive the engine via its real HTTP/WS API, never via internal function calls. The same tests pass whether the transport is local IPC, `localhost` HTTP, or remote-with-auth WebSocket.

## Test Pyramid

| Layer | Scope | Tooling | Speed | Run when |
|---|---|---|---|---|
| L1 — Contract | `claude` CLI surface (event shapes, flag behavior) | `bun:test` + tape recorder + JSON schema diff | Slow (real CLI) | Nightly + on CC version bump + manually |
| L2 — Engine unit | Pure modules: flag composer, manifest folder, event parser, schema validators | `bun:test` | Fast | Every commit |
| L3 — Engine integration | Real engine + Tape/Scripted backend + temp filesystem + ephemeral ports, driven via HTTP/WS | `bun:test` + Hono test client + `ws` | Medium | Every commit |
| L4 — UI component | Individual React components with mocked engine client | `vitest` + Testing Library | Fast | Every commit |
| L5 — E2E | Real web UI in a real browser against real engine + Tape/Scripted backend | Playwright | Slow | Pre-merge + nightly |
| L6 — Real-CLI smoke | A handful of scenarios against an actual `claude` install in a sandboxed cwd | Playwright + bun:test, gated | Slow + flaky-tolerant | Nightly + pre-release |
| L7 — Chaos / resilience | Engine integration + ChaosBackend (delays, crashes, partial output, disk full) | `bun:test` | Medium | Pre-merge + nightly |
| L8 — Performance budgets | Streaming throughput, large transcripts, attachment pipeline | `bun:test` + custom harness | Medium | Nightly + pre-release |

## Implementation Plan

### Phase T0 — Test Infrastructure (must land before any production code)

- [ ] T0.1. Choose and wire frameworks: `bun:test` for L2/L3/L7/L8, `vitest` for L4 (matches Vite ecosystem cleanly), Playwright for L5/L6. Single root `package.json` script per layer. Rationale: pinning the toolset up front prevents test-style drift across packages.
- [ ] T0.2. Stand up CI with three pipelines: **fast** (L2 + L3 + L4) on every push, **deep** (L5 + L7 + L8) on PRs to main, **nightly** (L1 + L6 + everything). Rationale: sub-2-min feedback for inner loop, exhaustive verification before merge, drift detection over time.
- [ ] T0.3. Build a **TestEnv harness** that, per test, provisions: a unique temp app-data dir, a unique temp `~/.claude`-shaped dir (via env var indirection), an ephemeral port for the engine, a fake clock, a tmp SQLite DB, and a teardown that kills any leaked subprocess in the test's process group. Rationale: hermeticity is non-negotiable for integration tests; one shared global state == permanent flake.
- [ ] T0.4. Build the **tape recorder CLI**: `bun run tape:record --name <slug> --prompt-file <path> [flags...]` runs real `claude -p`, captures stdin/stdout/stderr + argv + env + timing, writes to `tests/fixtures/cli-tapes/<slug>.tape.json`. Rationale: tapes are how we keep deterministic tests honest about real CLI behavior.
- [ ] T0.5. Implement **TapeBackend**: replays a tape with original inter-event timing (or fast-forwarded under fake clock), validates that the argv our flag composer produced matches the tape's recorded argv (or explicitly-allowed deltas). Rationale: if our flags drift from what the tape was recorded with, the test must fail loudly — that's the early-warning signal.
- [ ] T0.6. Implement **ScriptedBackend**: programmatic API like `backend.script().init('sess-123').assistantText('Hello').toolUse('Read', {path: 'x'}).toolResult('...').result({usage: {...}}).end()`. Rationale: tapes cover real-world shapes; scripted backends cover the long tail of edge cases without needing to record everything.
- [ ] T0.7. Implement **ChaosBackend** decorator: configurable delay/jitter, mid-stream crash, truncated NDJSON line, stderr noise, slow startup, refusal to exit on SIGTERM, port-already-in-use. Rationale: most production bugs in this kind of system are timing/failure-mode bugs, not happy-path bugs.
- [ ] T0.8. Build a **typed test client** for the engine HTTP/WS API, generated from `@clod-ui/contracts`. Used by L3 and L7. Rationale: tests should consume the wire contract, not internal modules — same mistake mode as the real UI.
- [ ] T0.9. Build assertion helpers: `expectEventSequence(events, pattern, {ordered|partial|unordered})`, `expectArgvMatches(...)`, `expectManifestFold(...)`, `expectFileTreeMatches(...)`, `expectNoZombies()`. Rationale: a small, expressive vocabulary makes tests read like specs, not like plumbing.
- [ ] T0.10. Write the **flake-detection job**: nightly job that runs L3+L5+L7 N times in a row; any test that fails <100% of the time gets auto-tagged `@flaky` and a tracking issue is filed. Rationale: silently-flaky tests are worse than no tests; institutionalize their detection.

### Phase T1 — Spine Tests (the "specification by example" set)

These are written **first**, fail meaningfully, and stay green forever. They are the executable contract of the engine.

- [ ] T1.1. **New conversation captures session_id**: POST `/conversations`, send first user turn, observe `system.init` event over WS, assert engine persists `claude_session_id` in SQLite *and* in `manifest.json`. Backend: ScriptedBackend.
- [ ] T1.2. **Resume re-passes flags and uses `--resume`**: send a second turn on the same conversation; assert flag composer produced argv containing `--resume <id>` plus all per-conversation settings (model, tool allowlist, system-prompt mode). Backend: TapeBackend with argv assertion.
- [ ] T1.3. **Resume after engine restart**: start engine, complete a turn, kill engine, restart with same app-data dir, send another turn on the same conversation, assert continuity. Backend: ScriptedBackend.
- [ ] T1.4. **Streaming ordering invariants**: assistant text deltas arrive in order; every `tool_use` is followed by a matching `tool_result` (or `tool_error`); `result` is the last event of a turn. Property-style test over many random valid scripts. Backend: ScriptedBackend with sequence generators.
- [ ] T1.5. **Cancel ladder**: start a turn that "hangs" (ChaosBackend delays output forever); call cancel; assert SIGINT sent immediately, SIGTERM after configured grace, SIGKILL after final grace; engine emits `cancelled` event; conversation state returns to `idle`; `expectNoZombies()` passes. Backend: ChaosBackend over ScriptedBackend.
- [ ] T1.6. **Cancel before first event**: cancel a turn that hasn't emitted anything yet; assert clean shutdown, no orphan, conversation untouched.
- [ ] T1.7. **Crash mid-stream**: ChaosBackend kills the subprocess after the third event; engine emits `error{kind: 'cli_crashed'}`, marks turn as failed-retryable, leaves transcript in a coherent partial state, no zombie.
- [ ] T1.8. **Concurrent send is rejected**: while a turn is in flight, a second send on the same conversation returns HTTP 409 with a typed error; queueing endpoint is a separate explicit call.
- [ ] T1.9. **Settings round-trip**: PATCH conversation settings (model, thinking effort, allowed tools, system prompt); next turn's argv reflects the change exactly; `manifest.json` records the change as an event with timestamp.
- [ ] T1.10. **Manifest fold invariants**: given a sequence of manifest events, the projected state matches an oracle implementation; manifest is append-only (test attempts to mutate prior entries and asserts rejection).
- [ ] T1.11. **Transcript watcher**: write a synthetic line to the conversation's JSONL out-of-band; assert the engine emits a `transcript.updated` WS event within 200ms (under fake clock) and the projected message list updates.
- [ ] T1.12. **Healthcheck + readiness**: `/health` returns `{cli: 'ok'|'missing'|'unauthenticated', version: '...'}`; engine refuses turn submissions while `cli != 'ok'` with a typed error.

### Phase T2 — Feature Integration Tests (per Phase 1–6 of architecture plan)

- [ ] T2.1. **Flag composer matrix**: parameterized table test covering every supported combination of (model × thinking-effort × system-prompt-mode × tool config × skills × MCP) → expected argv + env. This is the single source of truth for what flags mean to us.
- [ ] T2.2. **System prompt modes**: append vs override produce the right CLI flag (`--append-system-prompt` vs `--system-prompt`); switching modes mid-conversation is recorded in manifest and reflected next turn.
- [ ] T2.3. **Allowed/disallowed tools**: granular patterns (e.g. `Bash(git:*)`) survive the round-trip from UI → settings → argv unchanged; conflicting allow+deny resolves predictably and is documented.
- [ ] T2.4. **Skills enablement**: enabling/disabling a skill produces the expected backend mutation (whatever Claude Code's current mechanism is) — abstracted behind the `SkillsBackend` trait so the test pins the contract, not the implementation detail.
- [ ] T2.5. **Preferences UI ↔ settings.json**: editing prefs writes a schema-valid file atomically (temp + rename), creates `.bak`, and a malformed input is rejected before write. Property test: random valid edits never produce an invalid file on disk.
- [ ] T2.6. **Image attachment**: attach a PNG, send turn, assert the stream-json input payload contains an `image` content block constructed correctly (base64 or file-ref per detected CC version), assert downscaling applied above threshold, assert `attachments/` contains the canonical copy.
- [ ] T2.7. **File attachment**: attach a `.txt`, send turn, assert the user message includes a file reference and `Read` tool is permitted for that path; assert the file is *not* embedded inline.
- [ ] T2.8. **Attachment cleanup**: delete a conversation, assert its `cwd/attachments/`, `cwd/artifacts/`, and `scratch/` are removed; orphan-sweeper command finds and reports leaked files in a corrupt scenario.
- [ ] T2.9. **Auto-titling**: after first assistant turn, a second `claude -p` invocation (no resume, no tools) is dispatched and the resulting title is persisted; failures fall back gracefully to a date-based title.
- [ ] T2.10. **Per-conversation cwd isolation**: tools invoked in conversation A cannot read files in conversation B's cwd unless explicitly permitted — verified by a ScriptedBackend that "tries" and asserts the permission decision.
- [ ] T2.11. **Diagnostics panel**: every turn appears in the diagnostics log with redacted argv (no secrets) and a "Copy repro" payload that, when fed into a separate test fixture loader, reproduces the same backend invocation.
- [ ] T2.12. **Error taxonomy**: each known error class (auth_failed, rate_limited, model_unavailable, tool_denied, mcp_unreachable, cli_missing, cli_unauthenticated, cli_crashed, transcript_corrupt) has a fixture stderr/stream sample → engine maps to the correct typed error → UI renders the correct affordance.

### Phase T3 — UI E2E Tests (Playwright)

- [ ] T3.1. **Bootstrap**: launcher starts engine, browser opens, healthcheck visible; missing-CLI screen appears when `claude` is absent (simulated via PATH manipulation in the test env).
- [ ] T3.2. **Send a message and see streaming render**: against a Tape that includes assistant text + one tool_use + tool_result, assert text appears progressively, tool card renders collapsed by default, expanding shows input/output.
- [ ] T3.3. **Activity pill transitions**: pill text reflects `starting → thinking → tool: Read → streaming → idle` with no skipped or stuck states.
- [ ] T3.4. **Cancel button**: visible during a turn, clicking it transitions UI to `cancelling → idle` within configured budgets, retry affordance visible.
- [ ] T3.5. **Composer locking**: while a turn is active the textarea is visually disabled; pressing Enter does not send; "Send after current finishes" affordance queues exactly one message.
- [ ] T3.6. **Pickers actually change behavior**: change model in the picker, send a turn, open diagnostics, assert argv contains the new `--model` value. Repeat for thinking-effort and system-prompt-mode.
- [ ] T3.7. **Attachment drag/drop and paste**: drop an image, see chip; paste an image from clipboard, see chip; drop a too-large file, see rejection toast.
- [ ] T3.8. **Conversation switcher** (`Cmd+K`): opens, fuzzy-matches titles, Enter switches; arrow-key navigation; Esc closes without changing.
- [ ] T3.9. **Responsive layout**: viewport sweep at 360px / 768px / 1280px / 2560px; sidebar collapses below threshold; no horizontal scroll on text content; touch-friendly hit targets at narrow widths.
- [ ] T3.10. **Theme**: light / dark / system; switching is immediate and persists across reloads.
- [ ] T3.11. **Reload mid-stream**: while a turn is streaming, full-page reload; UI re-attaches to the same in-flight turn via WS resubscribe; no duplicated content, no lost suffix.
- [ ] T3.12. **Engine restart while UI open**: kill engine, UI shows disconnected banner; restart engine, UI auto-reconnects, conversation state intact.

### Phase T4 — Resilience / Chaos

- [ ] T4.1. **Slow CLI startup**: ChaosBackend delays first event by 5s under fake clock; UI activity pill shows `starting`, no false-timeout, eventual stream proceeds normally.
- [ ] T4.2. **Truncated NDJSON line**: engine handles a partial line gracefully (buffers until newline) and emits a parse error only on actual malformed JSON, not on slow writers.
- [ ] T4.3. **Subprocess refuses SIGTERM**: cancel ladder escalates to SIGKILL; engine still cleans up child process group; `expectNoZombies()` passes.
- [ ] T4.4. **Disk full on attachment write**: returns typed error, conversation state unchanged, no half-written files left on disk.
- [ ] T4.5. **Disk full on settings write**: atomic write semantics preserve the prior `settings.json`; UI shows the failed save and the user's edits are preserved in-memory for retry.
- [ ] T4.6. **Port collision on engine start**: launcher tries N alternative ports, surfaces a clear error if all fail.
- [ ] T4.7. **Two engines on same app-data dir**: second engine refuses to start, citing the first via pidfile lock. Test races by starting both nearly simultaneously.
- [ ] T4.8. **WS client disconnect mid-turn**: the in-flight turn continues server-side; reconnecting client receives a replay of missed events from a server-side buffer up to a configured window.
- [ ] T4.9. **JSONL transcript corruption**: transcript reader skips unparseable lines, emits a `transcript_corrupt` warning event with line numbers, never crashes the engine.
- [ ] T4.10. **Manifest corruption**: an unparseable manifest line halts further appends and surfaces a recovery action; engine reads up to the last valid event and continues read-only.

### Phase T5 — Performance Budgets

- [ ] T5.1. **Streaming throughput**: 10k assistant text deltas in under X seconds end-to-end (engine→WS→UI render); fail the budget if regressed by >10% vs baseline.
- [ ] T5.2. **Large transcript open**: a 5MB JSONL transcript opens with first paint under Y ms (virtualized list); scrolling to bottom under Z ms.
- [ ] T5.3. **Attachment pipeline**: a 50MB image goes from drop → chip → ready-to-send under K ms (downscaling included); memory peak stays under cap.
- [ ] T5.4. **Engine cold start**: from `bun run start` to `/health == ok` under L ms.
- [ ] T5.5. **Concurrent conversations**: ten parallel ScriptedBackend conversations stream simultaneously without missed events or interleaved corruption (each conversation's events are strictly ordered within itself).

### Phase T6 — Network-Mode Forward Compatibility (no production code yet, just test seams)

- [ ] T6.1. **Transport-agnostic test client**: the L3 test client takes a transport adapter (`local-loopback` | `localhost-http` | `remote-ws`), so today's tests run unchanged on tomorrow's transport.
- [ ] T6.2. **Auth contract test (skipped, future)**: a placeholder test marked `skip` that asserts the engine refuses requests without a valid token when bound to non-loopback. Acts as a TODO breadcrumb.
- [ ] T6.3. **Origin/CSRF contract test (skipped, future)**: WS upgrade rejects unexpected `Origin` headers when network mode is on. Placeholder.
- [ ] T6.4. **Token rotation contract test (skipped, future)**: engine accepts old token for a grace window after rotation; placeholder.

These intentionally-skipped tests live in the suite from day one so the implementation phase is "make them pass," not "remember to write them."

## What "TDD-aligned" means here, concretely

- Every Phase T1 spine test is **written and committed before** the engine code that satisfies it. A spine test that doesn't fail in the right way before implementation is itself broken and gets fixed first.
- Every Phase T2 feature test is **paired with the corresponding architecture-plan task** and lands in the same PR or just before it.
- E2E tests (T3) lag implementation by at most one PR; each user-visible feature ships with at least one E2E.
- Chaos and performance tests (T4, T5) start as `skip`-stubs at task-definition time so the surface is enumerated, then are filled in as the relevant subsystems land.

## Verification Criteria

- `bun run test:fast` runs L2 + L3 + L4 in under 2 minutes on a clean checkout.
- `bun run test:deep` runs L5 + L7 + L8 in under 15 minutes.
- All Phase T1 spine tests are green and have been observed to fail in a meaningful, distinguishing way against an obviously-broken engine implementation (i.e., they actually test what they claim to).
- Code coverage is reported per package but is not a gate; **scenario coverage** (an enumerated list of behaviors with at least one test each) is the gate.
- Zero shared global state across tests, verified by a deliberate "shuffle order N times" CI job.
- Flake rate of L3+L5+L7 over a rolling 30-day window stays below 1% per test; any test exceeding it is auto-quarantined.
- A new contributor can, in under 10 minutes from clone, run `bun run test:fast` and see green.

## Potential Risks and Mitigations

1. **Tape staleness as Claude Code evolves.**
   Mitigation: nightly L1 contract job re-runs the recorder against pinned prompts and diffs against current tapes; any drift opens an issue automatically. Tapes carry a `cc_version` field; tests warn (not fail) when mismatched, fail when shape diverges.

2. **Fake-clock leakage corrupting unrelated tests.**
   Mitigation: clock is per-TestEnv (not global); a lint rule forbids importing the global clock module outside `TestEnv`; CI shuffle-order job catches leaks fast.

3. **Playwright flakiness from real-time animations and streaming.**
   Mitigation: the UI exposes a `?test=1` mode that disables non-essential animations and exposes hooks for "stream-step here"; assertions use deterministic data-testids and event hooks rather than visual polling where possible.

4. **Test suite slowness as the matrix grows.**
   Mitigation: ScriptedBackend is pure-in-process and parallelizable; bun:test runs files in parallel; tape replays use fast-forward by default; the slow real-CLI suite is gated to nightly.

5. **Over-mocking the backend so tests pass while the real CLI breaks.**
   Mitigation: every Phase T2 feature test has a corresponding L1 tape proving the backend really emits what we mocked; any feature test without a corresponding tape is flagged in CI.

6. **Test code rotting faster than production code (the "tests as a parallel codebase" trap).**
   Mitigation: testing utilities live in a versioned `@clod-ui/test-kit` package with the same code-review bar as production; assertion helpers are documented and have their own micro-tests.

7. **Chaos tests hiding real bugs by being too lenient.**
   Mitigation: every chaos test asserts a *specific* observable end state (event kind, file existence, manifest entry), not just "didn't crash."

## Alternative Approaches

1. **Skip L1 tapes; rely on L2/L3 mocks only.** Faster to set up, but loses early warning on CLI surface drift — the single highest-risk dependency in the whole system. Not recommended given the spec.

2. **Drop bun:test for vitest across the board.** Single test runner, slightly larger ecosystem. Trade-off: vitest in a Bun runtime works but adds a layer; bun:test is native and very fast. Defensible alternative if we hit toolchain friction with bun:test.

3. **Use Cypress instead of Playwright for E2E.** Mature, friendly DX. Trade-off: weaker multi-tab/multi-context support, which we'll want for "two browser windows on the same engine" tests in the network-mode era.

4. **Record-replay HTTP/WS at the transport layer instead of NDJSON tapes at the CLI layer.** Pros: fully deterministic UI tests with no engine running. Cons: hides real engine bugs. Useful as an additional layer for pure-UI regression, but does not replace L3/L5.

## Open Assumptions

- **`bun:test` is mature enough** for our needs as of authoring; we'll re-evaluate at Phase T1 completion if its DX or stability disappoints.
- **No CI provider chosen yet**; the strategy assumes "any Linux runner with macOS available for a subset" and leaves the concrete provider open.
- **The engine is single-process**; if we later split into multiple processes (e.g. a dedicated subprocess supervisor), the harness's `expectNoZombies()` must learn the new topology.
- **Network-mode tests stay `skip`-stubbed** until the auth/transport story is designed; Phase T6 explicitly does not block any earlier phase.
