# Clod UI — PR #1 Scope: Foundation, Test Infra, Spine Tests (v2)

> **Status:** This plan supersedes `plans/landed/2026-04-23-clod-ui-pr1-foundation-v1.md`. That file is archived by Task 1.2 of this plan. Future agent sessions should read only this v2.
>
> **What changed vs v1:**
> 1. **Bun version pinning** is now concrete and belt-and-suspenders (§1 + §9.1).
> 2. **README** added as an explicit task (§11) with bounded scope (TL;DR for experienced devs, ≤ ~100 lines).
> 3. **`nightly.yml` CI runner reduced to `ubuntu-latest` only.** macOS matrix deferred to the PR that introduces L6 real-CLI smoke (ref: test strategy plan).
> 4. **Task 1.2** additionally archives this plan's v1 alongside the architecture v1.
>
> **Audience:** the implementation agent that takes over after this planning session ends.
>
> **Reads required:**
> - `plans/2026-04-23-clod-ui-architecture-v2.md`
> - `plans/2026-04-23-clod-ui-test-strategy-v1.md`
> - `initial-summoning.md`
>
> **Reads forbidden (archive-only):**
> - `plans/2026-04-23-clod-ui-initial-architecture-v1.md`
> - `plans/landed/2026-04-23-clod-ui-pr1-foundation-v1.md`
>
> Both are moved to `docs/archive/` by Task 1.2 of this plan; do not adopt any decisions from them.

## Objective

Land the **foundational PR** for `clod-ui`: initialize git, archive obsolete plans, scaffold the Bun monorepo per v2 architecture, stand up full Phase T0 test infrastructure, author all twelve Phase T1 spine tests (skipped with FIXME markers), wire CI (`fast`/`deep`/`nightly`) so `bun run ci:fast` passes locally and on GitHub Actions, ship a minimal README, end with a clean green build. **No production engine logic, no UI rendering logic, no real CLI integration.** Skeleton + harness + failing-by-design spec only.

## End-State Acceptance

- `git log` clean history; v1 plans moved via `git mv` to `docs/archive/`.
- `bun install` from fresh clone: success, < 60s warm cache.
- `bun run ci:fast` exits 0 locally and on `fast.yml`, < 2 min, zero flakes over 10 consecutive runs.
- Twelve Phase T1 spine tests exist, `.skip()`-ed with `// FIXME(phase-2.x): unskip when [X] lands` comments.
- Phase T0 test infrastructure fully implemented; test-kit self-tests green.
- Lint, format, typecheck green across all packages.
- `lefthook` pre-commit blocks failing-lint commits; pre-push runs `ci:fast`.
- `README.md` exists at repo root, bounded in scope (§11), no `LICENSE` or `CHANGELOG.md` created.
- `.bun-version` and `packageManager` field both pin the same exact Bun version.
- Startup guard in `scripts/ci.ts` rejects a Bun-version mismatch with a clear error.

## Implementation Plan

### Section 1 — Repo Initialization & Bun Pinning

- [ ] Task 1.1. `git init` in `/Users/example/Projects/clod-ui`. Ensure `init.defaultBranch = main`. Single empty initial commit: `git commit --allow-empty -m "chore: initial commit"`.
- [ ] Task 1.2. Create `docs/archive/`. Execute:
  - `git mv plans/2026-04-23-clod-ui-initial-architecture-v1.md docs/archive/`
  - `git mv plans/landed/2026-04-23-clod-ui-pr1-foundation-v1.md docs/archive/` (if present)
  Prepend this banner line to each archived file: `> **SUPERSEDED.** Active plans are in \`plans/\`. Do not use this document for implementation decisions.`
- [ ] Task 1.3. `.gitignore`: `node_modules/`, `dist/`, `build/`, `coverage/`, `playwright-report/`, `playwright/.cache/`, `*.log`, `.DS_Store`, `.env`, `.env.*`, `app-data-dev/`, `tmp/`, `.bun/`, `.vscode/`. Do **not** ignore `bun.lockb`.
- [ ] Task 1.4. `.gitattributes`: `* text=auto eol=lf`, `*.lockb binary`, `*.png binary`, `*.jpg binary`, `*.ico binary`.
- [ ] Task 1.5. `.editorconfig`: 2-space indent, LF, UTF-8, trim trailing whitespace, final newline.
- [ ] Task 1.6. **Bun version pinning (belt-and-suspenders):**
  - Run `bun --version`; record the output as `BUN_VERSION` for this task.
  - Create `.bun-version` containing exactly `BUN_VERSION` (no leading `v`, no range modifiers).
  - In the root `package.json` (Task 2.1), add `"packageManager": "bun@<BUN_VERSION>"` — must match `.bun-version` byte-for-byte.
  - The PR description must record the pinned version explicitly and note it was pinned from the building agent's environment.
- [ ] Task 1.7. `lefthook.yml`:
  - `pre-commit`: `bun run lint:staged`, `bun run typecheck`.
  - `pre-push`: `bun run ci:fast`.
  - Document the `LEFTHOOK=0` bypass in the PR description (not in a README).

### Section 2 — Bun Workspace Monorepo Skeleton

- [ ] Task 2.1. Root `package.json`:
  - `"private": true`, `"type": "module"`, `"packageManager": "bun@<BUN_VERSION>"` (from §1.6).
  - `"workspaces": ["apps/*", "packages/*"]`.
  - Scripts: `lint`, `lint:staged`, `format`, `format:check`, `typecheck`, `test:fast`, `test:deep`, `test:nightly`, `ci:fast`, `ci:deep`, `ci:nightly`, `tape:record`, `start`, `dev`.
  - DevDeps: `typescript`, `eslint`, `@typescript-eslint/*`, `eslint-plugin-import`, `prettier`, `lefthook`, `@types/bun`.
- [ ] Task 2.2. `tsconfig.base.json` — strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`. Path aliases `@clod-ui/*` → `packages/*/src` and `apps/*/src`.
- [ ] Task 2.3. `eslint.config.js` (flat config): typescript-eslint recommended, import-sort, `no-floating-promises` (error), `no-console` (warn outside `scripts/`), `prefer-const`, `no-restricted-imports` (forbid cross-package deep imports — must go through package entry points).
- [ ] Task 2.4. `.prettierrc.json`: `{"semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100, "tabWidth": 2}`. `.prettierignore` mirrors `.gitignore`.
- [ ] Task 2.5. Create directory tree exactly per v2 architecture §"Repository Layout":
  ```
  apps/{engine,web,launcher}/
  packages/{contracts,backend,manifest,settings,test-kit}/
  tests/{fixtures/cli-tapes,e2e,smoke}/
  docs/archive/
  scripts/
  .github/workflows/
  ```
  Each `apps/*` and `packages/*` gets a `package.json`, `tsconfig.json` (extends base), `src/index.ts`, and a one-line package-internal `README.md` (describing the package's purpose — these are package-level readmes referenced by `package.json#readme`, distinct from the root README in §11).
- [ ] Task 2.6. `.gitkeep` files in: `tests/fixtures/cli-tapes/`, `tests/e2e/`, `tests/smoke/`, `docs/archive/` (add after Task 1.2's moves so dir exists either way).

### Section 3 — `@clod-ui/contracts` (minimum viable)

- [ ] Task 3.1. Dep: `zod`. `src/event-envelope.ts`: Zod schema for `EventEnvelope` per v2 §"Wire Protocol" — `{v: literal(1), id: string.uuid, ts: number, kind: string, conv_id?: string.uuid, payload: unknown}`. Export inferred type.
- [ ] Task 3.2. `src/health.ts`: `HealthResponse` — `{cli: enum(['ok','missing','unauthenticated','crashed']), version?: string, engine_version: string, started_at: number}`.
- [ ] Task 3.3. `src/errors.ts`: Zod schemas for the error taxonomy in v2 Task 2.6. One schema per kind; discriminated union export.
- [ ] Task 3.4. `src/index.ts` re-exports. No other schemas in this PR.
- [ ] Task 3.5. `src/version.ts`: `PROTOCOL_VERSION = 1 as const`, `assertProtocolVersion(v): asserts v is 1`.
- [ ] Task 3.6. Self-tests: `tests/contracts.test.ts` asserts each schema accepts a good fixture + rejects a bad one.

### Section 4 — `@clod-ui/backend` (interface + stubs)

- [ ] Task 4.1. Dep: `@clod-ui/contracts` (workspace).
- [ ] Task 4.2. `src/types.ts`: TS interfaces for `ClaudeBackend`, `TurnRequest`, `BackendEvent`, `HealthStatus`, `BackendOptions` per v2 Task 2.2.
- [ ] Task 4.3. `src/not-implemented.ts`: `NotImplementedBackend implements ClaudeBackend` — every method throws `Error('NotImplemented: phase 2.x will provide this')`.
- [ ] Task 4.4. Stub files with `export {}` + TODO comment naming the v2/T-plan task: `src/real.ts`, `src/tape.ts`, `src/scripted.ts`, `src/chaos.ts`, `src/compose.ts`.
- [ ] Task 4.5. Self-test: `tests/not-implemented.test.ts` asserts every method throws.

### Section 5 — `@clod-ui/manifest` and `@clod-ui/settings` (types only)

- [ ] Task 5.1. `@clod-ui/manifest/src/types.ts`: `ManifestEvent` discriminated union (`conversation.created`, `settings.applied`, `attachment.added`, `artifact.observed`, `model.changed`, `tool_config.changed`, `skills.changed`, `system_prompt.changed`), `ManifestReader`, `ManifestWriter`.
- [ ] Task 5.2. `@clod-ui/manifest/src/index.ts` re-exports types only. `// IMPL: phase 3.2` comment.
- [ ] Task 5.3. `@clod-ui/settings/src/types.ts`: `ClaudeSettings` covering documented CC keys (`theme`, `model`, `allowedTools`, `disallowedTools`) plus `unknown: Record<string, unknown>` passthrough.
- [ ] Task 5.4. `@clod-ui/settings/src/index.ts` re-exports types only. `// IMPL: phase 3.6`.

### Section 6 — `@clod-ui/test-kit` (full implementation)

The most consequential package in this PR; everything below is real working code.

- [ ] Task 6.1. Deps: `@clod-ui/contracts`, `@clod-ui/backend`. Dev: `@types/ws`.
- [ ] Task 6.2. `src/test-env.ts`: `class TestEnv` with `create({name?})` static factory and `dispose()`. Provisions `os.tmpdir()/clod-ui-test/<test-id>/{app-data, fake-claude-home}/`; allocates ephemeral port via `Bun.listen({port: 0})` then closes; tracks process-group root PID. On dispose: `kill -- -<pgid>` + `rm -rf`. Accessors: `appDataDir`, `fakeClaudeHome`, `port`, `clock`.
- [ ] Task 6.3. `src/clock.ts`: `FakeClock` class — `now()`, `tick(ms)`, `setTimeout`/`setInterval` replacements. Per-TestEnv instance only; never global. `installFakeClock(env)` swizzles clock-aware modules.
- [ ] Task 6.4. `src/scripted-backend.ts`: `ScriptedBackend implements ClaudeBackend`. Builder API: `script().init(sessionId).assistantText(s).thinkingText(s).toolUse(name, input).toolResult(content).toolError(msg).result({usage}).cancelled().error(kind, detail).end()`. Returns events as `AsyncIterable` from `startTurn()`. Cancel resolves immediately.
- [ ] Task 6.5. `src/tape-backend.ts`: `TapeBackend implements ClaudeBackend`. Loads a tape file; validates argv against recorded argv (explicitly-listed safe deltas allowed); replays events with original timing under FakeClock. Tape format: `{cc_version, recorded_at, argv, env_redacted, stdin_b64, events: [{ts_ms, line}], stderr: [...], exit_code}`.
- [ ] Task 6.6. `src/chaos-backend.ts`: `ChaosBackend` — decorator wrapping any backend. Config: `{startupDelayMs?, perEventJitterMs?, crashAfterEvents?, truncateLastLine?, refuseSigtermFor?, slowExitMs?}`.
- [ ] Task 6.7. `src/typed-test-client.ts`: factory taking `TestEnv`, returning typed HTTP+WS client matching contracts, with helpers `submitTurn`, `cancelTurn`, `awaitEvent(matcher, {timeout})`, `recordEvents(convId)`. Uses `fetch` + Bun's built-in WebSocket. In PR #1, targets `MockEngineServer` (§6.8).
- [ ] Task 6.8. `src/mock-engine-server.ts`: minimal Hono app wrapping a `ClaudeBackend`, exposing the v2 wire protocol surface — just enough for the typed client + spine tests to be written against it. **Not** the production engine; lives in test-kit forever. The production `apps/engine` will share the same wire surface.
- [ ] Task 6.9. `src/assertions.ts`:
  - `expectEventSequence(events, pattern, {mode: 'ordered'|'partial'|'unordered'})`
  - `expectArgvMatches(actual, expected, {allowExtra?: string[]})`
  - `expectManifestFold(events, expectedState)`
  - `expectFileTreeMatches(rootDir, expectedTree)`
  - `expectNoZombies(env)` — runs `ps -o pid,pgid,comm`; asserts no `claude` processes share env's pgid.
- [ ] Task 6.10. `src/tape-recorder.ts` + `bin/record-tape.ts`: CLI runnable as `bun run tape:record --name <slug> --prompt-file <path> [--cwd <path>] [--allow-tools <list>] [--model <id>]`. Spawns real `claude -p`, captures per tape format, writes to `tests/fixtures/cli-tapes/<slug>.tape.json`. Not in CI; manual + nightly-maintenance.
- [ ] Task 6.11. Self-tests (MUST be green in this PR):
  - `tests/scripted-backend.test.ts`
  - `tests/tape-backend.test.ts` (with a hand-authored fixture tape)
  - `tests/chaos-backend.test.ts`
  - `tests/test-env.test.ts` (hermeticity, reaping)
  - `tests/assertions.test.ts`
  - `tests/mock-engine.test.ts` (typed client round-trip against MockEngineServer + ScriptedBackend)

### Section 7 — Phase T1 Spine Tests (authored, skipped)

Twelve files under `tests/spine/`, each `.skip()`-ed with a FIXME comment naming the v2 task that un-skips it.

- [ ] Task 7.1. `T1.01-new-conversation-captures-session-id.test.ts` — un-skipped by v2 Tasks 2.7 + 3.3.
- [ ] Task 7.2. `T1.02-resume-passes-flags.test.ts` — v2 Tasks 2.4 + 2.7.
- [ ] Task 7.3. `T1.03-resume-after-restart.test.ts` — v2 Tasks 3.1 + 3.3.
- [ ] Task 7.4. `T1.04-streaming-ordering.test.ts` — v2 Tasks 2.3 + 2.8.
- [ ] Task 7.5. `T1.05-cancel-ladder.test.ts` — v2 Task 2.5.
- [ ] Task 7.6. `T1.06-cancel-before-first-event.test.ts` — v2 Task 2.5.
- [ ] Task 7.7. `T1.07-crash-mid-stream.test.ts` — v2 Tasks 2.6 + 7.4.
- [ ] Task 7.8. `T1.08-concurrent-send-rejected.test.ts` — v2 Task 2.7.
- [ ] Task 7.9. `T1.09-settings-roundtrip.test.ts` — v2 Tasks 3.6 + 5.4.
- [ ] Task 7.10. `T1.10-manifest-fold-and-append-only.test.ts` — v2 Task 3.2.
- [ ] Task 7.11. `T1.11-transcript-watcher.test.ts` — v2 Task 3.4.
- [ ] Task 7.12. `T1.12-health-and-readiness.test.ts` — v2 Tasks 2.7 + 0.3.

Each file: `describe.skip(...)` with FIXME; fully authored body (not a stub); short top-of-file docstring in plain English stating the contract.

### Section 8 — App Skeletons (placeholders only)

- [ ] Task 8.1. `apps/engine/src/index.ts`: Bun + Hono app with **only** `GET /health` returning `{cli: 'missing', version: undefined, engine_version: '0.0.0', started_at: Date.now()}`. Binds `127.0.0.1:0`; logs chosen port. `dev` script runs `bun --hot src/index.ts`. No subprocess, SQLite, or WS yet.
- [ ] Task 8.2. `apps/web/`: `bun create vite` scaffold (React + TS), Tailwind configured, shadcn/ui initialized with a single Button as smoke test. Default page renders `"Clod UI — Connecting to engine…"`. No engine client.
- [ ] Task 8.3. `apps/launcher/src/index.ts`: stub script logging `"launcher: stub — phase 7.3 will implement"` and exiting 0.

### Section 9 — CI Pipelines

- [ ] Task 9.1. `scripts/ci.ts` (Bun script, three entry points invokable via `bun run scripts/ci.ts <fast|deep|nightly>`):
  - **Startup guard (first thing every entry point runs):** read `.bun-version`, compare to `Bun.version`, fail with a clear message if mismatched. Skippable only via `CLOD_UI_BUN_GUARD=off` env (for emergency local debug; never in CI).
  - `runFast()`: `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun run format:check`, `bun --filter '*' test` (L2 unit + test-kit self-tests; spine tests skipped). Fails on any non-zero.
  - `runDeep()`: everything in `runFast`, then placeholder `console.log('TODO: L5 Playwright + L7 chaos + L8 perf land in later PRs')`. Exits 0 — accepted gap, documented in script header.
  - `runNightly()`: everything in `runDeep`, then placeholder for L1 tape diff + L6 real-CLI smoke. Exits 0.
- [ ] Task 9.2. Root `package.json` scripts: `"ci:fast": "bun run scripts/ci.ts fast"`, `"ci:deep": "bun run scripts/ci.ts deep"`, `"ci:nightly": "bun run scripts/ci.ts nightly"`.
- [ ] Task 9.3. `.github/workflows/fast.yml`: `on: [push, pull_request]`. Single job on `ubuntu-latest`. Steps: checkout → `setup-bun` with `bun-version-file: .bun-version` → `bun install --frozen-lockfile` → `bun run ci:fast`. Caches `~/.bun/install/cache`.
- [ ] Task 9.4. `.github/workflows/deep.yml`: `on: pull_request: branches: [main]`. Same shape; runs `bun run ci:deep`. Adds Playwright browsers cache (no-op until L5 lands, but key is in place).
- [ ] Task 9.5. `.github/workflows/nightly.yml`: `on: schedule: cron: '0 7 * * *'` and `workflow_dispatch`. **Runner: `ubuntu-latest` only.** Runs `bun run ci:nightly`. Comment in the YAML: *"macOS matrix returns when L6 real-CLI smoke lands; until then it would run ubuntu only anyway."*
- [ ] Task 9.6. `.github/dependabot.yml`: Bun + GH Actions weekly updates, grouped minor+patch; Bun runtime bumps open individual PRs (so they're noticed).
- [ ] Task 9.7. `.github/CODEOWNERS`: single `* @<user>` line (leave `<user>` as a placeholder the building agent fills from the local git config).

### Section 10 — Final Sweep

- [ ] Task 10.1. Fresh-clone simulation: delete `node_modules`, reinstall, rerun `bun run ci:fast`. Must be green. Capture timing.
- [ ] Task 10.2. 10× consecutive `bun run ci:fast`: zero flakes required.
- [ ] Task 10.3. `git status` clean; `git ls-files | sort` recorded into the PR description.
- [ ] Task 10.4. Verify both v1 plans are at `docs/archive/...` with SUPERSEDED banners; neither present in `plans/`.
- [ ] Task 10.5. PR description includes:
  - Completed task links from this plan.
  - Pinned Bun version (in both `.bun-version` and `package.json#packageManager`).
  - `git ls-files` manifest.
  - Skipped spine test count (= 12).
  - Local `ci:fast` wall-clock.
  - Explicit "no production engine/UI logic in this PR" confirmation.

### Section 11 — README (bounded scope)

- [ ] Task 11.1. Author `/README.md` at repo root. **Hard cap: ~100 lines.** Target audience: experienced TS/Bun devs who just cloned the repo. Include, and **only** include:
  - **One-line description.** What Clod UI is (private chat UI routing through Claude Code CLI).
  - **Status line.** "Personal tool, under construction. Not intended for third-party use."
  - **Prerequisites.** macOS (primary target); Bun (version pinned in `.bun-version`); Claude Code CLI installed and authenticated (link to Anthropic's official install docs).
  - **Quick start.** Three commands: `bun install`, `bun run ci:fast` (verify), `bun run start` (launcher — stubbed in PR #1; note this explicitly).
  - **Dev loops.** `bun run dev` (per app), `bun run test:fast`, `bun run ci:fast`, `bun run tape:record -- --name <slug> --prompt-file <path>`.
  - **Repo layout.** The monorepo tree (as shown in v2 architecture §"Repository Layout") with one-line package descriptions.
  - **Where the design lives.** Pointers to `plans/2026-04-23-clod-ui-architecture-v2.md` and `plans/2026-04-23-clod-ui-test-strategy-v1.md` as canonical; note that `docs/archive/` is history, not spec.
  - **Known gaps for PR #1.** Bulleted list: engine is `/health`-only, web is "Connecting…" only, launcher is a stub, spine tests are skipped pending Phase 2.
  - **License / Contributing.** Single sentence: "Unlicensed private project; no external contributions expected."
  Do **not** include: marketing copy, screenshots, badges, a roadmap (the plans are the roadmap), FAQ, or any duplicated detail that belongs in the plans.
- [ ] Task 11.2. Link-check the README: every relative path mentioned (plans, dirs) must resolve at merge time. Part of `ci:fast` — add a simple link-check step to `scripts/ci.ts` that greps markdown links to repo-relative paths and stats each one.

## Verification Criteria

- `bun install` from clean clone: success, < 60s warm cache.
- `bun run ci:fast` green locally + on `fast.yml`, < 2 min, 0 flakes over 10 runs.
- `.bun-version` and `package.json#packageManager` match byte-for-byte; mismatched environments fail the startup guard with a clear message.
- All twelve spine files present, skipped, with FIXME comments pointing at v2 tasks.
- `docs/archive/` contains both v1 plans with SUPERSEDED banners; neither is in `plans/`.
- `README.md` exists, ≤ ~100 lines, scope matches §11 bounds.
- `lefthook` blocks a deliberately-broken commit (manually verified before merge).
- `apps/engine` `bun run dev` responds to `curl http://127.0.0.1:<port>/health`.
- `apps/web` `bun run dev` renders the connecting stub without errors.
- No `LICENSE` or `CHANGELOG.md` at root.
- `nightly.yml` runs on `ubuntu-latest` only (single-runner), with YAML comment noting the macOS-matrix deferral.

## Potential Risks and Mitigations

1. **Bun version drift between author machine, CI, and user machines.** Mitigation: pin in `.bun-version` + `packageManager`; startup guard in `ci.ts`; `setup-bun` uses `bun-version-file:`; dependabot proposes bumps as reviewable PRs.
2. **`shadcn/ui` init step generating files inconsistent with our lint/format.** Mitigation: run `bun run format` immediately after init; commit the formatted result.
3. **`lefthook` pre-push (`ci:fast`) annoying developers (you) during rapid iteration.** Mitigation: document `LEFTHOOK=0` bypass in PR description; pre-commit stays fast (lint+typecheck only).
4. **`bun:test` parallelism causing port collisions in test-kit's MockEngineServer.** Mitigation: every TestEnv allocates its own ephemeral port; never hardcode.
5. **Hono + Bun WebSocket edge cases in MockEngineServer.** Mitigation: keep MockEngineServer minimal in PR #1; richer behavior deferred.
6. **Spine tests rotting while skipped.** Mitigation: each imports real types from contracts/backend; type-level changes break compile; `tsc --noEmit` over test tree is part of `ci:fast`.
7. **Implementation agent over-reaching into Phase 2.** Mitigation: End-State Acceptance explicit about out-of-scope; PR description requires confirming no production logic; reviewer (you) has clear grounds to push back.
8. **README growing into a doc.** Mitigation: the hard cap (§11) + link-check forces discipline; future agents see "~100 lines, §11 bounds" as a standing contract.

## Alternative Approaches

1. **Single mega-PR for Phase 0 + 1 + 2.** Faster to runnable app; loses test-first cadence; produces an unreviewable PR. Rejected.
2. **Skip MockEngineServer; spine tests call backends directly.** Smaller PR; loses wire-contract enforcement (the whole point of transport-agnostic testing). Rejected.
3. **Minor-pin Bun (`~1.x.y` in `packageManager`).** Auto-patch updates; risks silent regressions in infra we care about. Rejected in favor of exact-pin + dependabot.
4. **Skip README entirely until post-merge.** Smaller PR; but the user explicitly asked for a dev-onboarding README; honored.

## Open Items for the Implementation Agent

- **Bun version**: whatever `bun --version` reports at commit time, written into both `.bun-version` and `package.json#packageManager`, recorded in PR description.
- **LICENSE / CHANGELOG**: do **not** create. Surface in PR description as post-merge questions for the user.
- **GitHub repo creation + `origin` remote**: out of scope; user pushes when ready.
- **Anthropic Claude Code GitHub Action wiring**: out of scope; deferred to a later infra PR.
- **`@<user>` in CODEOWNERS**: fill from `git config user.name` (or ask in the PR description if the local git identity is ambiguous).
- **If anything is ambiguous**: prefer `architecture-v2` and `test-strategy-v1` as tiebreakers; if still unclear, leave a TODO + surface in PR description. Do not guess.
