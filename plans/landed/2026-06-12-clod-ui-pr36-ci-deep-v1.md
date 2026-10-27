# PR #36 — ci:deep de-stubbing: Playwright E2E (completion goal S11)

Date: 2026-06-12. Spec: completion goal S11; test-strategy L5.
Substrate: `scripts/ci.ts deep` = runFast + TODO logs; `deep.yml`
already caches `~/.cache/ms-playwright` ("key is in place so future
PRs… pick up cached browsers"); `tests/e2e/` is an empty placeholder;
ChaosBackend(ScriptedBackend) emits `turn.cancelled` — the
cancel-capable hermetic backend; diagnostics route (S8) exposes argv.

## Pinned decisions

- **D1 — `@playwright/test` at the root, chromium only.** The deep tier
  runs `playwright test` (its own runner — bun/vitest stay untouched).
  `scripts/ci.ts deep` runs `bunx playwright install chromium` first
  (idempotent, cached locally and by the workflow's existing cache key);
  the workflow gains `--with-deps` for ubuntu system libs.
- **D2 — a real serve entrypoint, no duplicated plumbing.** The
  WS-upgrade + broadcast + replay block in `index.ts`'s main is
  extracted into an exported `startEngineServer(context, { port })`;
  production main and the new `tests/e2e/serve-deep.ts` both call it
  (drift-proof by construction). `serve-deep.ts`: temp app-data dir,
  `ChaosBackend(ScriptedBackend(script…, { perEventDelayMs }), {})`,
  `createApp({ backend, store, db, diagnostics: {}, static: { dir:
  apps/web/dist } })`, port 4609. One test-only fetch intercept:
  `POST /_test/drop-sockets` closes every live WS (the reconnect-banner
  trigger) — deep-entrypoint-only, never in the engine proper.
- **D3 — one spec, six pinned scenarios** (the goal's list):
  boot (health badge ok) → new conversation → send → streamed text
  renders → completes; cancel mid-stream (slow scripted events; Cancel
  button → cancelled status pill); reconnect banner (drop-sockets →
  `data-state="reconnecting"` appears, then clears on reconnect);
  controls → argv (pick model `sonnet`, send, `GET /diagnostics` shows
  `--model sonnet` — S8's route as the assertion surface, as the goal
  pinned). Assertions on `data-test`/`data-state` markers only (I-3).
- **D4 — `playwright.config.ts` under `tests/e2e/`**, `webServer`
  spawning serve-deep (Playwright owns lifecycle + readiness), workers:
  1 (scenarios share one engine; ordering matters), retries: 0 locally
  (flakes surface loudly; CI may revisit in S12).
- **D5 — ci.ts `runDeep`:** runFast → build the web dist
  unconditionally (the SPA under test must be current, the launcher's
  build-if-missing rule is not enough here) → playwright install →
  `bunx playwright test --config tests/e2e/playwright.config.ts`,
  exit code propagated.
- **D6 — planted-failure verification** (goal exit): during
  implementation, flip one assertion, observe `bun run ci:deep` exit
  non-zero, revert; the docs commit records the observation. Not a
  permanent fixture.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Refactor:** extract `startEngineServer` (index.ts main uses it;
   ci:fast green proves no behavior change).
3. **E2E:** dep + config + serve-deep + spec; iterate locally with
   `bun run ci:deep` until green; planted-failure check (D6).
4. **CI wiring:** ci.ts runDeep + deep.yml install step.
5. **Docs:** README (ci:deep no longer a stub), CLAUDE/PROGRESS/goal
   S11 ✅, rotate plan, INDEX, NEXT-SESSION (S12 next).

## Deferred (named)

- Firefox/WebKit projects — chromium-only until a cross-browser bug
  proves the cost.
- `TODO(deep-screenshots)` — failure screenshots/traces are on by
  Playwright default config; artifact upload in CI deferred to S12's
  workflow pass.

## Commits

1. `docs(plans): PR #36 ci-deep plan + INDEX row`
2. `refactor(engine): extract startEngineServer from the production main`
3. `feat(e2e): playwright deep tier — serve-deep + six-scenario spec`
4. `feat(ci): ci:deep runs the playwright tier for real`
5. `docs: land PR #36 — rotate plan, refresh`
