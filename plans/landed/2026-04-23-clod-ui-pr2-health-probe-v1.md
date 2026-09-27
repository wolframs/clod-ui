# Clod UI — PR #2 Scope: Real `/health` CLI Probe (v1)

> **Status:** Active. First slice of Phase 2. Depends on PR #1 (merged).
>
> **Reads required:**
> - `plans/2026-04-23-clod-ui-architecture-v2.md` §Phase 2 (Tasks 2.6, 2.7) + §Phase 0 Task 0.3
> - `plans/2026-04-23-clod-ui-test-strategy-v1.md`
> - `plans/landed/2026-04-23-clod-ui-pr1-foundation-v2.md` (for conventions + commit style)

## Objective

Make `GET /health` reflect the real machine state instead of the PR-#1 hard-coded `{cli: 'missing'}`. Ship a `RealClaudeBackend.health()` implementation that probes the installed Claude Code CLI via `claude --version`, caches the result, refreshes on a timer, and never blocks the HTTP handler on CLI I/O. Un-skip **2 of 4** tests in `tests/spine/T1.12-health-and-readiness.test.ts` (the `missing` and `ok` cases). Leave `unauthenticated` and `state transitions` tests skipped with refined TODOs pointing at a future PR that decides the auth-probe strategy.

## End-State Acceptance

- `RealClaudeBackend` implements `health()` and `version()` (plus the existing NotImplemented throws on `startTurn` + `cancel` — those arrive in PR #3).
- Engine `/health` returns a `HealthResponse` whose `cli` field is computed from an actual probe of `claude --version`, cached for a configurable interval (default 5000 ms), refreshed in the background.
- Probe outcomes map as follows:
  - Binary not on PATH (ENOENT) → `{cli: 'missing'}`, no `version`.
  - Spawn succeeds, exit 0, stdout matches `^<semver>( .*)?$` → `{cli: 'ok', version}`.
  - Spawn times out (configurable, default 3000 ms) → `{cli: 'crashed'}`.
  - Any other exit → `{cli: 'crashed'}`.
- T1.12 tests 1 (`missing`) and 2 (`ok`) **un-skipped and green**. Tests 3–4 remain `.skip()`-ed with TODO pointing at PR #5.
- `bun run ci:fast` green locally, 10× with zero flakes.
- `claude --version` is never called synchronously from the request path — background refresh only.

## Implementation Plan

### Section 1 — `RealClaudeBackend` (`packages/backend/src/real.ts`)

- [ ] Task 1.1. Replace the stub `export {}` with a `RealClaudeBackend` class implementing `ClaudeBackend`.
  - Constructor accepts `BackendOptions` plus optional `{probeTimeoutMs?, versionRegex?}`.
  - `startTurn` / `cancel` throw `NotImplemented` with a PR-#3 pointer (so accidental calls in this PR fail loudly).
  - `version()` returns the cached version string or throws if probe did not yield one.
  - `health()` returns the current cached `HealthStatus`; triggers a refresh if the cache is empty or older than `staleAfterMs`. Refresh is fire-and-forget; method returns cached value immediately.
- [ ] Task 1.2. `probe()` internal method: `Bun.spawn(['<claudeBinary>', '--version'])` with timeout. Maps outcomes to `HealthStatus` per the mapping in End-State. Pure wrt `this` except for updating the cache.
- [ ] Task 1.3. Start method: `RealClaudeBackend.start()` kicks off the periodic refresh (default interval 5000 ms). `stop()` clears the interval and resolves any in-flight probe. Idempotent.
- [ ] Task 1.4. Export `RealClaudeBackend` from `packages/backend/src/index.ts`.

### Section 2 — Tests (`packages/backend/tests/real.test.ts`)

- [ ] Task 2.1. Write unit tests using real `Bun.spawn` but against synthetic shims placed in a temp dir (via a mini-helper in this test file — no test-kit changes needed). Cases:
  - Missing binary (`claudeBinary: '/nonexistent/claude'`) → `cli: 'missing'`.
  - Shim prints `2.1.118 (Claude Code)\n`, exits 0 → `cli: 'ok', version: '2.1.118'`.
  - Shim sleeps 10s, `probeTimeoutMs: 50` → `cli: 'crashed'`.
  - Shim exits 1 → `cli: 'crashed'`.
  - `health()` returns cached value without re-probing within `staleAfterMs`.

### Section 3 — Engine wiring (`apps/engine/src/index.ts`)

- [ ] Task 3.1. Instantiate `RealClaudeBackend` at module scope, call `start()` behind `import.meta.main` so tests can import `app` without side effects.
- [ ] Task 3.2. `/health` route: compose `HealthResponse` from `backend.health()` + static `engine_version` + `started_at`. No `await` that depends on fresh probe (method is sync-resolving from cache).
- [ ] Task 3.3. Graceful shutdown: on SIGINT/SIGTERM call `backend.stop()` then exit. Minimal; full shutdown lands in a later PR.

### Section 4 — T1.12 un-skip

- [ ] Task 4.1. Rewrite `tests/spine/T1.12-health-and-readiness.test.ts`:
  - Tests 1 + 2 move out of `describe.skip(...)` into `describe(...)`. Each spawns `apps/engine` as a subprocess with a controlled `PATH` (either empty-of-claude, or prepending a temp dir containing a synthetic shim), polls `/health` with a short timeout, asserts the expected fields.
  - Tests 3 + 4 stay in their own `describe.skip(...)` block with TODOs refined to point at PR #5 ("error taxonomy full + auth probe strategy").
  - Shared helper at the top of the file: `spawnEngine({env}): Promise<{url, stop}>` — spawns `bun run apps/engine/src/index.ts`, parses the `[engine] listening on http://127.0.0.1:<port>` log line for the port, returns an abort handle.

### Section 5 — Verification

- [ ] Task 5.1. `bun run ci:fast` green.
- [ ] Task 5.2. 10× consecutive `ci:fast`, zero flakes.
- [ ] Task 5.3. Manual smoke: `bun run --filter @clod-ui/engine dev`, `curl http://127.0.0.1:<port>/health` — returns `{cli: 'ok', version: '2.1.118', ...}` on this machine.

## Out of Scope (explicitly)

- `unauthenticated` detection strategy. Punted to PR #5 pending product decision (filesystem sniff vs probe-dispatch vs OAuth flow inspection).
- `RealClaudeBackend.startTurn` + `cancel` — arrive in PR #3.
- Flag composer, stream-JSON parsing, error taxonomy beyond `cli_*` kinds — PRs #3 + #5.
- WebSocket, SQLite, manifest — PRs #3 + #6.

## Risks

1. **Spawning `bun run …` as an engine subprocess in tests is slow on cold cache.** Mitigation: each test reuses one engine instance across both its assertions; total test wall time still under the 2-min `ci:fast` budget.
2. **Version regex drift** if Anthropic changes the `--version` output format. Mitigation: regex is configurable on the backend; one place to update.
3. **Background refresh leaking timers across test boundaries.** Mitigation: tests that construct a `RealClaudeBackend` call `stop()` in `afterEach`; engine subprocess tests terminate the child process.

## Open Items

- **PR description** should note that this PR leaves `unauthenticated` unimplemented by design (link to PR #5 when it exists).
- **Follow-up plan file** for PR #3 will be drafted once this PR merges.
