# Clod UI — PR #1 Scope: Foundation, Test Infra, Spine Tests

> **SUPERSEDED.** Active plans are in `plans/`. Do not use this document for implementation decisions.

> **Audience:** the implementation agent that takes over after this planning session ends.
>
> **Reads required:**
> - `plans/2026-04-23-clod-ui-architecture-v2.md` (canonical architecture, supersedes v1)
> - `plans/2026-04-23-clod-ui-test-strategy-v1.md` (canonical test strategy)
> - `initial-summoning.md` (original user spec)
>
> **Reads forbidden / archive-only:**
> - `plans/2026-04-23-clod-ui-initial-architecture-v1.md` — superseded; this PR moves it to `docs/archive/` (Task 1.2). Do not adopt any decisions from it.

## Objective

Land the **foundational PR** for `clod-ui`: initialize git, archive the obsolete plan, scaffold the Bun monorepo per the v2 architecture, stand up the full Phase T0 test infrastructure, author all twelve Phase T1 spine tests (skipped with TODO markers pointing at the Phase 2 task that will un-skip each one), wire CI so `bun run ci:fast` passes locally and on GitHub Actions, and end with a clean green build whose only "work remaining" signal is the count of skipped spine tests.

Critically: **no production engine logic, no UI rendering logic, no real CLI integration ships in this PR.** This is exclusively the skeleton + the test harness + the failing-by-design spec.

## End-State Acceptance (what "done" looks like)

- `git log` shows a clean initial-commit history; the v1 plan has been moved (not copied) via `git mv` to `docs/archive/`.
- `bun install` from a fresh clone succeeds in under 60 seconds on a warm cache.
- `bun run ci:fast` exits 0 locally and on the GH Actions `fast.yml` runner, in under 2 minutes.
- All twelve Phase T1 spine tests exist, are `.skip()`-ed with a `// FIXME(phase-2.x): unskip when [X] lands` comment, and the skip count is visible in test output.
- Phase T0 test infrastructure (TestEnv, TapeBackend, ScriptedBackend, ChaosBackend, typed test client, assertion helpers, tape recorder CLI) is fully implemented and has its own self-tests, all green.
- Lint, format, and typecheck are green across all packages.
- Pre-commit hook (`lefthook`) blocks commits that would fail `bun run ci:fast`.
- The README/LICENSE/CHANGELOG questions are **left to the user** — do not create them in this PR.

## Implementation Plan

### Section 1 — Repo Initialization & Hygiene

- [ ] Task 1.1. `git init` in `/Users/example/Projects/clod-ui`. Set `init.defaultBranch` to `main` if not already. Make a single empty initial commit (`git commit --allow-empty -m "chore: initial commit"`) so subsequent moves preserve history.
- [ ] Task 1.2. Create `docs/archive/`. Use `git mv plans/2026-04-23-clod-ui-initial-architecture-v1.md docs/archive/2026-04-23-clod-ui-initial-architecture-v1.md`. Prepend a single line to the moved file: `> **SUPERSEDED.** Active plan: \`plans/2026-04-23-clod-ui-architecture-v2.md\`. Do not use this document for implementation decisions.`
- [ ] Task 1.3. Author `.gitignore` covering: `node_modules/`, `dist/`, `build/`, `coverage/`, `playwright-report/`, `playwright/.cache/`, `*.log`, `.DS_Store`, `.env`, `.env.*`, `app-data-dev/`, `tmp/`, `.bun/`, `.vscode/` (except `.vscode/settings.json` if we add a shared one — for now ignore the whole dir). Do **not** ignore `bun.lockb`.
- [ ] Task 1.4. Author `.gitattributes`: `* text=auto eol=lf`, `*.lockb binary`, `*.png binary`, `*.jpg binary`, `*.ico binary`.
- [ ] Task 1.5. Author `.editorconfig`: 2-space indent, LF line endings, UTF-8, trim trailing whitespace, final newline.
- [ ] Task 1.6. Pin Bun version: create `.bun-version` containing the current stable Bun version string (whatever the implementing agent's `bun --version` reports; record it in the PR description).
- [ ] Task 1.7. Add `lefthook.yml` with `pre-commit` hooks: `bun run lint:staged`, `bun run typecheck`. Add `pre-push` hook: `bun run ci:fast`. Document the bypass (`LEFTHOOK=0 git commit ...`) in the PR description, not in a README.

### Section 2 — Bun Workspace Monorepo Skeleton

- [ ] Task 2.1. Create root `package.json`:
  - `"private": true`, `"type": "module"`, `"packageManager": "bun@<pinned>"`
  - `"workspaces": ["apps/*", "packages/*"]`
  - Root scripts: `lint`, `lint:staged`, `format`, `format:check`, `typecheck`, `test:fast`, `test:deep`, `test:nightly`, `ci:fast`, `ci:deep`, `ci:nightly`, `tape:record`, `start`, `dev`. Each calls into `scripts/ci.ts` or workspace scripts via `bun --filter`.
  - DevDeps: `typescript`, `eslint`, `@typescript-eslint/*`, `eslint-plugin-import`, `prettier`, `lefthook`, `@types/bun`, `tsx` (only if needed for non-Bun tooling — prefer Bun-native).
- [ ] Task 2.2. Create `tsconfig.base.json` with strict settings: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"noPropertyAccessFromIndexSignature": true`, `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"verbatimModuleSyntax": true`, `"isolatedModules": true`, `"skipLibCheck": true`. Path aliases for `@clod-ui/*` mapping to `packages/*/src` and `apps/*/src`.
- [ ] Task 2.3. Create `eslint.config.js` (flat config) at root: typescript-eslint recommended, import-sort, no-floating-promises (error), no-console (warn outside scripts/), prefer-const, no-restricted-imports (forbid cross-package deep imports: must go through package entry points).
- [ ] Task 2.4. Create `.prettierrc.json` with project conventions: `{"semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100, "tabWidth": 2}`. Add `.prettierignore` mirroring `.gitignore`.
- [ ] Task 2.5. Create the directory tree exactly as specified in v2 architecture plan §"Repository Layout":
  ```
  apps/{engine,web,launcher}/
  packages/{contracts,backend,manifest,settings,test-kit}/
  tests/{fixtures/cli-tapes,e2e,smoke}/
  docs/archive/
  scripts/
  .github/workflows/
  ```
  Each `apps/*` and `packages/*` directory gets a `package.json`, a `tsconfig.json` (extends base), a `src/index.ts` (initial named exports per below), and a `README.md` containing **only** a one-line description (these are package-internal docs, not project docs — exception to the no-docs rule because `package.json` "readme" fields point to them).
- [ ] Task 2.6. Add `.gitkeep` files to: `tests/fixtures/cli-tapes/`, `tests/e2e/`, `tests/smoke/`, `docs/archive/` (only after Task 1.2's move, but the dir must exist).

### Section 3 — `@clod-ui/contracts` (minimum viable)

- [ ] Task 3.1. Add deps: `zod`. Implement `src/event-envelope.ts`: Zod schema for `EventEnvelope` per v2 §"Wire Protocol" — `{v: literal(1), id: string.uuid, ts: number, kind: string, conv_id?: string.uuid, payload: unknown}`. Export inferred type.
- [ ] Task 3.2. Implement `src/health.ts`: Zod schema for `HealthResponse` — `{cli: enum(['ok','missing','unauthenticated','crashed']), version: string.optional(), engine_version: string, started_at: number}`. Export inferred type.
- [ ] Task 3.3. Implement `src/errors.ts`: Zod schemas for the typed error taxonomy enumerated in v2 Phase 2 Task 2.6. One schema per error kind; a discriminated union as the export.
- [ ] Task 3.4. Implement `src/index.ts` re-exporting the above. **Do not** add other schemas in this PR; they land with the phases that consume them.
- [ ] Task 3.5. Add `src/version.ts` exporting `PROTOCOL_VERSION = 1 as const` and a runtime check helper `assertProtocolVersion(v: number): asserts v is 1`.
- [ ] Task 3.6. Self-tests: a `tests/contracts.test.ts` (in the package) that asserts each schema accepts a known-good fixture and rejects a known-bad one. Uses `bun:test`.

### Section 4 — `@clod-ui/backend` (interface + stubs only)

- [ ] Task 4.1. Add deps: `@clod-ui/contracts` (workspace).
- [ ] Task 4.2. Implement `src/types.ts`: TS interfaces for `ClaudeBackend`, `TurnRequest`, `BackendEvent`, `HealthStatus`, `BackendOptions`. Method shapes per v2 Task 2.2.
- [ ] Task 4.3. Implement `src/not-implemented.ts`: `NotImplementedBackend implements ClaudeBackend` — every method throws `new Error('NotImplemented: phase 2.x will provide this')`. Used by spine tests in PR #1 so they fail meaningfully when un-skipped prematurely.
- [ ] Task 4.4. Stub files (with `export {}` or a single placeholder type) for: `src/real.ts`, `src/tape.ts`, `src/scripted.ts`, `src/chaos.ts`, `src/compose.ts`. Each contains a top-of-file comment naming the v2/T-plan task that will fill it in. These exist so future PRs touch known paths, not invent them.
- [ ] Task 4.5. Self-test: `tests/not-implemented.test.ts` asserts every method of `NotImplementedBackend` throws.

### Section 5 — `@clod-ui/manifest` and `@clod-ui/settings` (interface only)

- [ ] Task 5.1. `@clod-ui/manifest/src/types.ts`: TS interfaces for `ManifestEvent` (discriminated union — `conversation.created`, `settings.applied`, `attachment.added`, `artifact.observed`, `model.changed`, `tool_config.changed`, `skills.changed`, `system_prompt.changed`), `ManifestReader`, `ManifestWriter`. No implementations.
- [ ] Task 5.2. `@clod-ui/manifest/src/index.ts` re-exports types only. A `// IMPL: phase 3.2` comment marks where the impl lands.
- [ ] Task 5.3. `@clod-ui/settings/src/types.ts`: TS interfaces for `ClaudeSettings` (covering documented Claude Code settings.json keys we care about — `theme`, `model`, `allowedTools`, `disallowedTools`, plus an `unknown: Record<string, unknown>` passthrough so we don't drop unknown keys on round-trip).
- [ ] Task 5.4. `@clod-ui/settings/src/index.ts` re-exports types only. `// IMPL: phase 3.6`.

### Section 6 — `@clod-ui/test-kit` (full implementation)

This is the most consequential package in PR #1. Everything below is real working code.

- [ ] Task 6.1. Add deps: `bun:test` (built-in), `@clod-ui/contracts`, `@clod-ui/backend`. Dev: `@types/ws`.
- [ ] Task 6.2. Implement `src/test-env.ts`:
  - `class TestEnv` with `create({name?: string})` static factory and `dispose()` method.
  - On create: provisions `os.tmpdir()/clod-ui-test/<test-id>/{app-data, fake-claude-home}/`; allocates an ephemeral port via `Bun.listen({port: 0})` then closes; tracks the test's process group root PID.
  - On dispose: `kill -- -<pgid>` to reap any leaked children, then `rm -rf` the temp dirs.
  - Provides `appDataDir`, `fakeClaudeHome`, `port`, `clock` (see 6.3) accessors.
- [ ] Task 6.3. Implement `src/clock.ts`: a `FakeClock` class with `now()`, `tick(ms)`, `setTimeout/setInterval` replacements. Per-TestEnv instance only — never global. Export an `installFakeClock(env)` helper that swizzles the env's clock-aware modules.
- [ ] Task 6.4. Implement `src/scripted-backend.ts`: `ScriptedBackend implements ClaudeBackend`. Builder API: `script().init(sessionId).assistantText(s).thinkingText(s).toolUse(name, input).toolResult(content).toolError(msg).result({usage}).cancelled().error(kind, detail).end()`. Returns events from `startTurn()` as an `AsyncIterable` driven by the script. Cancel resolves immediately.
- [ ] Task 6.5. Implement `src/tape-backend.ts`: `TapeBackend implements ClaudeBackend`. Loads a tape file (path or in-memory object), validates argv against tape's recorded argv (allowing explicitly-listed safe deltas), replays events with original timing scaled by the env's FakeClock. Tape format: `{cc_version, recorded_at, argv, env_redacted, stdin_b64, events: [{ts_ms, line}], stderr: [...], exit_code}`.
- [ ] Task 6.6. Implement `src/chaos-backend.ts`: `ChaosBackend implements ClaudeBackend` — decorator wrapping any other backend. Config: `{startupDelayMs?, perEventJitterMs?, crashAfterEvents?, truncateLastLine?, refuseSigtermFor?, slowExitMs?}`. Used to simulate failure modes for the spine tests' chaos cases.
- [ ] Task 6.7. Implement `src/typed-test-client.ts`: factory that takes a `TestEnv` and returns a typed HTTP+WS client matching the contracts package, with helpers `submitTurn(convId, payload)`, `cancelTurn(convId)`, `awaitEvent(matcher, {timeout})`, `recordEvents(convId)`. Uses `fetch` for HTTP and `ws` (or Bun's built-in WebSocket) for WS. **PR #1 caveat:** since the engine isn't implemented yet, this client targets a `MockEngineServer` (also in test-kit) that wraps a chosen backend.
- [ ] Task 6.8. Implement `src/mock-engine-server.ts`: a minimal Hono app that wraps a `ClaudeBackend` and exposes the v2 wire protocol surface — *just enough* to let the typed test client and spine tests be written against it. This is **not** the production engine; it's a test fixture. Lives in test-kit forever; production engine in `apps/engine` will share the same wire surface.
- [ ] Task 6.9. Implement `src/assertions.ts`:
  - `expectEventSequence(events, pattern, {mode: 'ordered'|'partial'|'unordered'})`
  - `expectArgvMatches(actual, expected, {allowExtra?: string[]})`
  - `expectManifestFold(events, expectedState)`
  - `expectFileTreeMatches(rootDir, expectedTree)`
  - `expectNoZombies(env)` — runs `ps -o pid,pgid,comm` and asserts no `claude` processes share the env's pgid.
- [ ] Task 6.10. Implement `src/tape-recorder.ts` + `bin/record-tape.ts`: a CLI runnable as `bun run tape:record --name <slug> --prompt-file <path> [--cwd <path>] [--allow-tools <list>] [--model <id>]`. Spawns real `claude -p`, captures everything per the tape format, writes to `tests/fixtures/cli-tapes/<slug>.tape.json`. **Does not run in CI**; recording is a manual + nightly-maintenance action.
- [ ] Task 6.11. Self-tests for test-kit (these MUST be green in PR #1):
  - `tests/scripted-backend.test.ts`: a scripted sequence yields the expected event stream.
  - `tests/tape-backend.test.ts`: a fixture tape replays correctly under FakeClock.
  - `tests/chaos-backend.test.ts`: each chaos knob produces the documented effect.
  - `tests/test-env.test.ts`: hermeticity — two TestEnvs in the same process don't share state; child processes are reaped on dispose.
  - `tests/assertions.test.ts`: each helper passes on good input, fails with a useful message on bad input.
  - `tests/mock-engine.test.ts`: typed test client round-trips against MockEngineServer with ScriptedBackend.

### Section 7 — Phase T1 Spine Tests (authored, skipped)

Twelve test files under `tests/spine/`, each `.skip()`-ed with a comment naming the v2 task that un-skips it.

- [ ] Task 7.1. `tests/spine/T1.01-new-conversation-captures-session-id.test.ts` — un-skipped by v2 Task 2.7 + 3.3.
- [ ] Task 7.2. `tests/spine/T1.02-resume-passes-flags.test.ts` — un-skipped by v2 Task 2.4 + 2.7.
- [ ] Task 7.3. `tests/spine/T1.03-resume-after-restart.test.ts` — un-skipped by v2 Task 3.1 + 3.3.
- [ ] Task 7.4. `tests/spine/T1.04-streaming-ordering.test.ts` — un-skipped by v2 Task 2.3 + 2.8.
- [ ] Task 7.5. `tests/spine/T1.05-cancel-ladder.test.ts` — un-skipped by v2 Task 2.5.
- [ ] Task 7.6. `tests/spine/T1.06-cancel-before-first-event.test.ts` — un-skipped by v2 Task 2.5.
- [ ] Task 7.7. `tests/spine/T1.07-crash-mid-stream.test.ts` — un-skipped by v2 Task 2.6 + 7.4.
- [ ] Task 7.8. `tests/spine/T1.08-concurrent-send-rejected.test.ts` — un-skipped by v2 Task 2.7.
- [ ] Task 7.9. `tests/spine/T1.09-settings-roundtrip.test.ts` — un-skipped by v2 Task 3.6 + 5.4.
- [ ] Task 7.10. `tests/spine/T1.10-manifest-fold-and-append-only.test.ts` — un-skipped by v2 Task 3.2.
- [ ] Task 7.11. `tests/spine/T1.11-transcript-watcher.test.ts` — un-skipped by v2 Task 3.4.
- [ ] Task 7.12. `tests/spine/T1.12-health-and-readiness.test.ts` — un-skipped by v2 Task 2.7 + 0.3.

Each spine test file structure:
1. Import `TestEnv`, scripted/tape backend as needed, typed test client, assertion helpers.
2. `describe.skip(...)` block (or `test.skip` per case) with the FIXME comment.
3. Full body authored — the test must be ready to run on un-skip, not a stub.
4. A short top-of-file docstring restating the contract being tested in plain English.

### Section 8 — App Skeletons (placeholders only)

- [ ] Task 8.1. `apps/engine/src/index.ts`: a Bun + Hono app exposing **only** `GET /health` returning `{cli: 'missing', version: undefined, engine_version: '0.0.0', started_at: Date.now()}`. Binds `127.0.0.1:0` (ephemeral) and logs the chosen port. No subprocess code, no SQLite, no WS handlers. Add `package.json` script `dev` running `bun --hot src/index.ts`.
- [ ] Task 8.2. `apps/web/`: `bun create vite` scaffold (React + TS), Tailwind installed and configured, shadcn/ui initialized with a single Button component as smoke test. Default page renders "Clod UI — Connecting to engine…". No engine client yet.
- [ ] Task 8.3. `apps/launcher/src/index.ts`: a Bun script that logs `"launcher: stub — phase 7.3 will implement"` and exits 0. Exists so the workspace graph is complete.

### Section 9 — CI Pipelines (`scripts/ci.ts` + GH Actions shims)

- [ ] Task 9.1. Implement `scripts/ci.ts` as a Bun script with three exported entry-point functions invokable via `bun run scripts/ci.ts <fast|deep|nightly>`:
  - `runFast()`: `bun install --frozen-lockfile` (no-op locally if already), `bun run lint`, `bun run typecheck`, `bun run format:check`, `bun --filter '*' test` (runs L2 unit tests including test-kit self-tests; spine tests are skipped). Fails on any non-zero step.
  - `runDeep()`: everything in `runFast`, then placeholder `console.log('TODO: L5 Playwright + L7 chaos + L8 perf land in later PRs')`. Exits 0 — accepted gap, documented in the script's header comment.
  - `runNightly()`: everything in `runDeep`, then placeholder for L1 contract tape diff and L6 real-CLI smoke. Exits 0 with the same header note.
- [ ] Task 9.2. Root `package.json` scripts: `"ci:fast": "bun run scripts/ci.ts fast"`, `"ci:deep": "bun run scripts/ci.ts deep"`, `"ci:nightly": "bun run scripts/ci.ts nightly"`.
- [ ] Task 9.3. `.github/workflows/fast.yml`: triggers `on: [push, pull_request]`. Single job on `ubuntu-latest`. Steps: checkout, setup Bun (pinned), `bun install --frozen-lockfile`, `bun run ci:fast`. Caches `~/.bun/install/cache`.
- [ ] Task 9.4. `.github/workflows/deep.yml`: triggers `on: pull_request: branches: [main]`. Same shape, runs `bun run ci:deep`. Adds Playwright browsers cache step (no-op until L5 lands, but cache key is in place).
- [ ] Task 9.5. `.github/workflows/nightly.yml`: triggers `on: schedule: cron: '0 7 * * *'` (07:00 UTC) and `workflow_dispatch`. Matrix: `[ubuntu-latest, macos-latest]`. Runs `bun run ci:nightly`. The macOS runner is the future home of L6 real-CLI smoke.
- [ ] Task 9.6. Add `.github/dependabot.yml` configured for Bun + GitHub Actions weekly updates (low-noise: group minor+patch).
- [ ] Task 9.7. Optional but recommended: `.github/CODEOWNERS` with a single `* @<user>` line so future PR reviews are pre-routed.

### Section 10 — Final Sweep

- [ ] Task 10.1. Run `bun run ci:fast` from a fresh clone simulation (delete `node_modules`, reinstall, rerun). Must be green. Capture timing.
- [ ] Task 10.2. Run `bun run ci:fast` 10× consecutively to flake-check the test-kit self-tests. Zero flakes required.
- [ ] Task 10.3. Verify `git status` is clean and `git ls-files | sort` matches an expected manifest (record this manifest in the PR description for reviewer sanity).
- [ ] Task 10.4. Verify the v1 plan is at `docs/archive/...` and is no longer present in `plans/`. Verify its first line is the SUPERSEDED banner.
- [ ] Task 10.5. Author a single PR description that includes:
  - Which tasks from this plan were completed (link each).
  - The Bun version pinned in `.bun-version`.
  - The `git ls-files` manifest from Task 10.3.
  - The skipped spine test count (should be exactly 12).
  - The local `ci:fast` wall-clock time.
  - An explicit note that no production engine/UI logic is in this PR — by design.

## Verification Criteria

- `bun install` from clean clone: success, < 60s warm cache.
- `bun run ci:fast`: green locally and on `fast.yml`, < 2 min.
- `bun run ci:fast` × 10 consecutive: zero flakes.
- All test-kit self-tests (Section 6.11) green.
- All twelve spine test files exist; each is `.skip()`-ed with a FIXME comment naming the v2 task that un-skips it.
- `docs/archive/2026-04-23-clod-ui-initial-architecture-v1.md` exists; `plans/2026-04-23-clod-ui-initial-architecture-v1.md` does not.
- `lefthook` pre-commit hook blocks a commit that fails lint/typecheck (verified manually before merge).
- `apps/engine` `bun run dev` starts and responds to `curl http://127.0.0.1:<port>/health`.
- `apps/web` `bun run dev` shows "Clod UI — Connecting to engine…" without errors.
- No `README.md`, `LICENSE`, or `CHANGELOG.md` at the repo root (those are user-deferred decisions).
- No production logic in `apps/engine`, `apps/web`, `apps/launcher` beyond the documented stubs.

## Potential Risks and Mitigations

1. **Bun version drift between author machine and CI runner.**
   Mitigation: `.bun-version` pinned; `setup-bun` action consumes it; PR description records the version; failing CI on mismatch is acceptable (forces intentional upgrades).

2. **`shadcn/ui` init step generating unexpected files** that conflict with our lint/format settings.
   Mitigation: run `bun run format` immediately after init; commit the formatted result; lock the config in `components.json`.

3. **`lefthook` slowing down commits unacceptably.**
   Mitigation: pre-commit only runs lint:staged + typecheck (fast); pre-push runs `ci:fast` (slower but appropriate at push time, not commit time); document the `LEFTHOOK=0` bypass.

4. **`bun:test` parallelism causing port collisions in test-kit's MockEngineServer.**
   Mitigation: every TestEnv allocates its own ephemeral port; never hardcode; tests that need to know the port read it from `env.port`.

5. **Hono + Bun WebSocket integration edge cases** in the MockEngineServer.
   Mitigation: keep MockEngineServer minimal in PR #1 — only what the spine tests need; defer richer behavior to the production engine PR.

6. **Spine tests "rotting" while skipped** as adjacent code evolves.
   Mitigation: each spine test imports real types from `@clod-ui/contracts` and `@clod-ui/backend`, so type-level changes break compilation and force updates; `tsc --noEmit` over the test tree is part of `ci:fast`.

7. **Implementation agent over-reaching** and starting on Phase 2 in this PR.
   Mitigation: the "End-State Acceptance" section is explicit about what is **not** in scope; the PR description template (Task 10.5) requires confirming "no production engine/UI logic"; reviewer (the user) has clear grounds to push back.

## Alternative Approaches

1. **Single mega-PR for Phase 0 + Phase 1 + Phase 2 engine.** Faster to a runnable app, but loses the test-first cadence and produces a PR no one can review carefully. Rejected per the user's stated preference for quality over speed.

2. **Skip the MockEngineServer; have spine tests call backends directly.** Smaller PR #1. Loses the wire-contract enforcement that's the whole point of "tests consume the same API as the real UI." Rejected.

3. **Defer CI scaffolding to a later PR.** Smaller PR #1. Means the test infra ships without automation backing it; first regression appears at PR #2 with no safety net. Rejected.

## Open Items for the Implementation Agent

- **Bun version**: pin whatever your local `bun --version` reports at commit time; record it in the PR description.
- **README/LICENSE/CHANGELOG**: do **not** create. Surface this in the PR description as a question for the user to decide post-merge.
- **GitHub repo creation + remote `origin`**: out of scope for this PR; the user will create the remote and push when ready.
- **Anthropic Claude Code GitHub Action installation**: out of scope; v2 Phase 8 / a later infra PR will wire it.
- If anything in this plan is ambiguous: **prefer the v2 architecture plan and the test strategy plan** as tiebreakers. If those are also ambiguous, leave the ambiguity as a TODO comment and surface it in the PR description rather than guessing.
