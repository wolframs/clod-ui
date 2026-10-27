# apps/launcher

One-command launcher (Phase 7.3, PR #21): `bun run start` from the repo
root builds `apps/web/dist` if missing, spawns the engine with
`CLOD_UI_STATIC_DIR` pointed at it (engine serves the SPA same-origin),
polls `/health` with backoff, opens the default browser at the engine
URL, and forwards SIGINT/SIGTERM to the engine via an escalation ladder.

Crash recovery (Phase 7.4, PR #22): engine death after ready, without
an operator signal, with a non-zero exit → exactly one restart, pinned
to the first boot's port via `CLOD_UI_ENGINE_PORT` so the open tab's
origin survives. Death during boot, or a second death, propagates.

- `src/run.ts` — pure orchestration core; all side effects injected,
  fully covered by fake-driven tests in `tests/run.test.ts`.
- `src/effects.ts` — the real OS adapters (Bun.spawn, fetch, `open`).
- `CLOD_UI_NO_BROWSER=1` skips the browser open (CI, headless).

Deferred: `TODO(pidfile)`, `TODO(restart-policy)`, `TODO(ready-file)`.
See `plans/landed/2026-06-10-clod-ui-pr22-crash-recovery-v1.md`.
