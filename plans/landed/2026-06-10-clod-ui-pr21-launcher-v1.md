# PR #21 — Launcher (Phase 7.3): one command → working app

Date: 2026-06-10. Implements architecture v2 Task 7.3. `bun run start`
spawns the engine, serves the built web UI from the engine's origin,
polls `/health`, opens the default browser, forwards signals on exit.

## Context

- `apps/launcher/src/index.ts` is an honest stub (logs, exits 0).
- The engine serves **no static assets**; `apps/web/src/main.tsx` already
  defaults to same-origin for the engine URL ("in production, the launcher
  serves the engine and the web app from the same origin"). This PR makes
  that comment true by teaching the *engine* to serve the built SPA.
- Phase 7.1/7.2 are unlanded and the engine has **no pidfile hygiene** —
  the architecture line "same pidfile hygiene as the engine" references
  infrastructure that doesn't exist. Deferred: `// TODO(pidfile)`.

## Taxonomy decisions (pinned)

1. **Same-origin production model.** Engine gains an opt-in `static:
   { dir }` subsystem in `createApp`. Launcher points it at
   `apps/web/dist` and opens the browser at the engine origin. No
   `VITE_ENGINE_URL` in production; Vite dev flow unchanged.
2. **Static route semantics** (`apps/engine/src/routes/static.ts`):
   GET-only fallback registered *last* — API routes always win by Hono
   registration order. Resolution: exact file under `dir` → serve it;
   miss → `index.html` (SPA fallback); path-traversal attempts (resolved
   path escapes `dir`) → 404. Not configured → route absent (existing
   404). The I-1 `<surface> not configured` body is **deliberately not
   used**: static HTML is not a typed-client surface, and `GET /` must
   never return JSON to a browser.
3. **Engine wiring.** Production entrypoint reads `CLOD_UI_STATIC_DIR`;
   if set, passes `static: { dir }`. `createApp` validates nothing extra
   (static has no persistence dependency).
4. **Port discovery: parse the listen line.** Engine keeps its ephemeral
   port default; launcher parses `[engine] listening on
   http://127.0.0.1:<port>` from child stdout via pure
   `parseListenLine(line): string | null` (returns base URL). No fixed
   port, no collision handling, no extra IPC. `CLOD_UI_ENGINE_PORT`
   passthrough still works. A structured ready-file can replace this
   later if the line ever needs to change: `// TODO(ready-file)`.
5. **Health poll.** After the listen line: GET `/health` until HTTP 200
   or deadline. Pure `backoffDelays(opts)` generator: start 100ms,
   ×1.5, cap 1000ms, total deadline 10s. Failures (fetch reject or
   non-200) → next attempt; deadline → launcher kills child, exits 1.
6. **Browser open.** Platform map: darwin `open <url>`, linux
   `xdg-open <url>`, win32 `cmd /c start <url>`. Injected effect.
   `CLOD_UI_NO_BROWSER=1` skips (CI never opens Safari).
7. **Web build on missing dist.** If `apps/web/dist/index.html` is
   absent, launcher runs `bun run --filter @clod-ui/web build` (stdio
   inherited) before spawning the engine. Build-on-missing only — a
   *stale* dist is not detected (README documents the manual refresh).
8. **Signal forwarding.** SIGINT/SIGTERM on the launcher → SIGINT to
   engine child → 5s grace → SIGTERM → 2s grace → SIGKILL (mirrors the
   PR #5 cancel-ladder shape). Launcher exits with the child's exit
   code. Engine death *without* a launcher signal: log + exit with the
   child's code — auto-restart is Phase 7.4 (`// TODO(crash-restart)`).
9. **Pidfile: deferred.** `// TODO(pidfile)` in the entrypoint. Engine
   has none to mirror; inventing the convention launcher-first would put
   the canonical copy in the wrong place. Lands with 7.x hygiene work.
10. **Launcher architecture: pure core + injected effects.**
    `runLauncher(deps): Promise<number>` in `apps/launcher/src/run.ts`
    owns the orchestration state machine; every side effect is a `deps`
    member (`ensureWebBuilt`, `spawnEngine`, `fetchHealth`, `openBrowser`,
    `sleep`, `log`, `onSignal`). `apps/launcher/src/effects.ts` holds the
    real adapters; `src/index.ts` composes and runs. Tests drive the core
    with fakes — no real spawns, no real browsers (test-kit treatment).

## Tests

- **Spine T1.16** (`tests/spine/T1.16-static-assets.test.ts`): boots
  `createApp` with a tmp static dir. Contracts: `/` → index.html;
  `/assets/app.js` → exact file; unknown path → index.html (SPA
  fallback); traversal escape → 404; `/health` still routes (API
  precedence); unconfigured app → `/` 404. Append SPINE.md row.
- **Launcher unit** (`apps/launcher/tests/*.test.ts`, bun): pure
  `parseListenLine` + `backoffDelays` tables; `runLauncher` with fake
  deps — happy path (build skipped when dist present, browser opened
  once with parsed URL), build-on-missing ordering, health deadline →
  child killed + exit 1, signal → SIGINT forwarded + child exit code
  propagated, `CLOD_UI_NO_BROWSER` handled in effects (core takes a
  plain `openBrowser: (url) => ...`).

## Commits

1. `docs(plans)`: this plan + backfill #18d.3 INDEX row + README
   known-gaps line (drift found during pickup: 9eacc79 rotated the plan
   but skipped the INDEX/README refresh it claimed).
2. `feat(engine)`: static-assets subsystem (`routes/static.ts`,
   `createApp` opt + `CLOD_UI_STATIC_DIR`) + spine T1.16 + SPINE.md row.
3. `feat(launcher)`: pure core — `parseListenLine`, `backoffDelays`,
   `runLauncher` + unit tests.
4. `feat(launcher)`: real effects + entrypoint (spawn engine, build web,
   open browser, signal ladder) — replaces the PR #1 stub.
5. `docs`: land PR #21 — rotate plan, INDEX row, README quickstart +
   known-gaps, CLAUDE.md WIP, NEXT-SESSION.md for the next instance.

## Deferred (named)

- `TODO(pidfile)` — pidfile hygiene for engine + launcher (7.x).
- `TODO(crash-restart)` — auto-restart once + disconnected banner (7.4).
- `TODO(ready-file)` — structured readiness handshake replacing the
  stdout listen-line parse, if it ever needs to change.
- Stale-dist detection (content-hash or mtime check) — not worth it
  until someone gets bitten.
