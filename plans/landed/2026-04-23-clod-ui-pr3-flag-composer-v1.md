# Clod UI — PR #3 Scope: Flag Composer + Streaming Ordering (v1)

> **Status:** Active. Second slice of Phase 2. Depends on PR #2 (merged / staged).
>
> **Reads required:**
> - `plans/2026-04-23-clod-ui-architecture-v2.md` §Phase 2 Task 2.4 (flag composer), §Task 2.2 (backend interface), §Task 5.2 (thinking effort mapping)
> - `plans/2026-04-23-clod-ui-test-strategy-v1.md` T1.02, T1.04, T2.1
> - `plans/landed/2026-04-23-clod-ui-pr2-health-probe-v1.md` (for conventions + commit style)

## Scope Note (why this is a tight slice)

The prior-PR slicing table pencilled **RealClaudeBackend.startTurn + engine routes + flag composer + T1.01/T1.02/T1.04** into a single PR. On grounding against the actual CLI surface (`claude --help`) and the existing `MockEngineServer` + `TypedTestClient`, the composer is independently landable and the T1.04 property test already has everything it needs (MockEngineServer broadcasts envelopes today). Bundling the real subprocess + stream-JSON parser + process-group supervision into the same PR would:

- push us past a comfortable review budget,
- force educated guesses about the exact stream-JSON stdin/NDJSON shapes before we've recorded a tape,
- tangle the composer's pure-function tests with subprocess timing.

So PR #3 is **flag composer + T1.02 + T1.04**. T1.01 stays skipped (its contract demands SQLite + manifest persistence per the in-file TODO — that's Phase 3, PR #6 territory). The real `startTurn` moves to PR #4 under a dedicated plan.

## Objective

Implement the pure `compose(TurnRequest) => {argv, env, stdin}` function in `@clod-ui/backend`, covering every field of `TurnRequest` with test coverage that matches the T2.1 matrix promise. Un-skip two spine tests that the composer unblocks: T1.02 (resume carries the session id + settings into argv) and T1.04 (streaming ordering invariants hold across the envelope layer).

## End-State Acceptance

- `packages/backend/src/compose.ts` exports `compose(req, opts?)` producing `{argv, env, stdin}`. Pure; no I/O.
- Argv always starts with `<claude> -p --input-format stream-json --output-format stream-json --verbose`. Subsequent flags reflect every set field of `TurnRequest`.
- Flag mapping:
  - `resume_session_id` → `--resume <id>`
  - `model` → `--model <name>`
  - `thinking_effort` → `--effort <low|medium|high|max>` (mapping documented in-module); `off` omits the flag
  - `system_prompt.mode === 'append'` → `--append-system-prompt <text>`
  - `system_prompt.mode === 'override'` → `--system-prompt <text>`
  - `allowed_tools` → `--allowedTools <a> <b> …`
  - `disallowed_tools` → `--disallowedTools <a> <b> …`
  - `cwd` → `--add-dir <cwd>` (so tool access is permitted) *and* surfaced via `ComposeResult.cwd` (spawn helper uses it as the working directory)
  - `attachments[*].path` → appended to `--add-dir` so `Read` works against them
  - `skills` → **deferred**; composer records `skills` into `ComposeResult.pendingSkills` with a clear TODO pointing at Phase 5.6 (`SkillsBackend`)
- `env`: inherits nothing from `process.env` (that's the spawn layer's job); composer returns *only the keys it adds*. Empty object today; Phase 5.2 may add `MAX_THINKING_TOKENS` if we decide env-var is the implementation arm.
- `stdin`: a single stream-JSON line encoding the user message with optional image content blocks from attachments. Documented shape; a dedicated test pins the bytes.
- T1.02 un-skipped and green.
- T1.04 un-skipped: a property-style test generates N (default 20) random valid event scripts, submits each through `MockEngineServer` + `ScriptedBackend`, collects envelopes via `TypedTestClient`, asserts the three invariants.
- `bun run ci:fast` green, 10× with zero flakes, no process leaks.

## Implementation Plan

### Section 1 — Flag composer

- [ ] Task 1.1. Replace the `export {}` stub in `packages/backend/src/compose.ts` with the real `compose()` implementation. Co-locate a `THINKING_EFFORT_MAP` constant (exported for the UI to use later). Re-export the function from `packages/backend/src/index.ts`.
- [ ] Task 1.2. `ComposeResult` shape:
  ```ts
  interface ComposeResult {
    argv: string[];
    env: Record<string, string>;
    stdin: Uint8Array;
    cwd: string;
    pendingSkills?: string[];
  }
  ```
- [ ] Task 1.3. `ComposeOptions`:
  ```ts
  interface ComposeOptions {
    claudeBinary?: string;      // default: 'claude'
    extraArgv?: string[];       // raw-flags escape hatch (architecture Task 5.8); appended verbatim
  }
  ```

### Section 2 — Composer matrix tests

- [ ] Task 2.1. `packages/backend/tests/compose.test.ts` — a parameterized table covering:
  - bare minimum (only `turn_id`, `conv_id`, `user_message`, `cwd`)
  - with `resume_session_id`
  - each `thinking_effort` value (including `off` → no flag)
  - `system_prompt` in `append` vs `override`
  - `allowed_tools` / `disallowed_tools` (single + multiple + both simultaneously)
  - `model` specified vs absent
  - one or more `attachments`
  - `skills` populated → composer surfaces `pendingSkills`
  - `extraArgv` appended
- [ ] Task 2.2. A dedicated stdin byte-shape test. Encodes a user message with an image attachment, asserts the exact JSON envelope shape (single line of stream-JSON). Fragility acknowledged in-plan: when Phase T1 adds a real recorded tape, the two should diverge only in trivial ways; if they diverge materially, this test becomes the place to update.

### Section 3 — T1.02 un-skip

- [ ] Task 3.1. Rewrite `tests/spine/T1.02-resume-passes-flags.test.ts` to:
  - build a realistic `TurnRequest` with `resume_session_id: 'sess-x'`, `model: 'sonnet'`, `system_prompt: {mode: 'append', text: '...'}`, `allowed_tools: ['Read']`
  - call `compose(req)`
  - assert argv, via `expectArgvMatches`, contains `--resume sess-x --model sonnet --append-system-prompt <text> --allowedTools Read`
  - retains its describe name; FIXME comment cleared.

### Section 4 — T1.04 un-skip

- [ ] Task 4.1. Rewrite `tests/spine/T1.04-streaming-ordering.test.ts`:
  - generator produces random valid scripts via the `script()` builder (random assistant deltas, random `tool.use → tool.result|tool.error` pairs, always ends with `.result()`)
  - for each generated script, spin up a `MockEngineServer` + `TypedTestClient`, submit a turn, collect envelopes per-`turn_id` until a `turn.result` is seen
  - assert invariants:
    1. `turn.result` is strictly the last envelope for that turn_id
    2. every `tool.use` is followed (in turn_id-scoped sequence) by a matching `tool.result` *or* `tool.error`
    3. `assistant.delta` envelopes preserve the order they were produced (ScriptedBackend is strictly in-order; the test re-confirms the envelope layer doesn't re-order)
  - run 20 random scripts per test run; seed the PRNG deterministically so failures are reproducible; log the seed on failure
  - teardown reliably `.stop()`s the server and `.close()`s the client in `finally`

### Section 5 — Verification

- [ ] Task 5.1. `bun run ci:fast` green.
- [ ] Task 5.2. 10× consecutive `ci:fast`, zero flakes. Property-test seed deterministic so any flake is reproducible.
- [ ] Task 5.3. `ps` check post-run: no bun/claude pgids leaked from T1.04's server spawns.

## Out of Scope (explicitly)

- `RealClaudeBackend.startTurn` + real stream-JSON parsing → PR #4.
- `apps/engine` routes beyond `/health` → PR #4 (the routes already exist in `MockEngineServer` and will be mirrored there).
- Cancel ladder → PR #5.
- Error taxonomy stderr sniffers → PR #5.
- SQLite + manifest + T1.01's persistence half → PR #6.
- Skills backend (`pendingSkills` is a seat, not an implementation) → Phase 5.6.
- `MAX_THINKING_TOKENS` env var arm of thinking effort → deferred pending decision in Phase 5.2.

## Risks

1. **`stdin` byte-shape drift.** The stream-JSON input shape isn't (yet) locked by a recorded tape; our compose-test asserts the shape we *think* the CLI wants. Mitigation: the test is isolated, easy to update; when PR #4 records its first tape the two can be cross-checked.
2. **Property test flakes** if the script generator produces invalid sequences. Mitigation: generator is closed (only composes from legal builder methods) + every test run uses a deterministic seed + seed is logged on failure.
3. **Port exhaustion** if the property test forgets to stop servers. Mitigation: `finally { server.stop() }` inline; port 0 (ephemeral); assertion count kept at 20 per run.

## Open Items

- **PR description** should note PR #4 as the next slice (routes + real startTurn) and link the in-file FIXMEs that still reference phase-2 tasks.
- **Follow-up plan file** for PR #4 will be drafted once this PR merges.
