# PR #22 — Crash recovery (Phase 7.4): "it came back"

Date: 2026-06-10. Implements the *engine-crash* half of architecture v2
Task 7.4: launcher auto-restarts a dead engine once; web shows a
disconnected banner until the stream is back.

## Session strategy (pinned with the operator, 2026-06-10)

This session is **two PRs, strictly ordered**:

1. **PR #22 (this plan)** — crash recovery. Code slice, lands first.
2. **PR #23 — architecture v3 refresh.** Docs slice, lands second, *after*
   #22, so it documents settled Phase 7 reality (port pinning,
   restart-once semantics, banner contract) instead of guessing at it.
   Scope: reconcile the v2 doc against reality — Zustand/TanStack never
   adopted, framed WS client→server messages never built, Phase 7
   half-landed, CI tiers stubbed. Amend, don't rewrite-from-scratch;
   drift table + corrected decisions. Same token discipline as PR plans.

**Escape hatch:** the halves are separable by construction. If #22
sprawls, #23 drops to the next session with zero damage (an unwritten
doc isn't broken code). The reverse cut doesn't exist — never land half
of #22 to start #23.

## Context (verified during the PR #21 session)

- The *CLI-subprocess* death half of Task 7.4 already landed in PR #5 —
  spine T1.07 pins `turn.error{kind: cli_crashed, retryable: true}`.
  This PR is launcher restart + UI banner only.
- `runLauncher` (apps/launcher/src/run.ts) already supervises
  `handle.exited`; `// TODO(crash-restart)` marks the insertion point.
  The fake harness (apps/launcher/tests/run.test.ts) drives everything
  without real spawns.
- After a restart the ephemeral port would change, killing the already-
  open browser tab's origin. Engine honors `CLOD_UI_ENGINE_PORT`.
- `useSubscribe` already exposes `idle|connecting|open|reconnecting|closed`
  (docs/INVARIANTS.md I-2); T1.14 pins `?since=` replay incl. the gap case.

## Taxonomy decisions (pinned)

1. **Restart once per launcher lifetime.** Engine death *after* reaching
   ready (healthy), *without* an operator signal, and with a **non-zero
   exit code** → one restart. (Refined during impl: exit 0 is a
   deliberate shutdown, not a crash — it propagates; the pre-existing
   happy-path test pins this.) A second death → launcher exits with the
   engine's code. No restart counters/windows until someone needs them
   (`TODO(restart-policy)`).
2. **Death before ready never restarts.** A crash during boot is a
   config/bug problem, not a transient; propagate the exit code (today's
   behavior, unchanged).
3. **Port pinning on restart.** Core extracts the port from the first
   boot's parsed base URL and passes it into the respawn; effects set
   `CLOD_UI_ENGINE_PORT=<port>` on the child env. The browser tab's
   origin survives. If the pinned port can't be bound on restart, the
   engine exits during boot → rule 2 applies → launcher gives up.
   `spawnEngine` dep grows an options arg: `(onLine, opts?: { port?: number })`.
4. **No second browser open.** The tab exists; the reconnecting client
   takes over. Assert `open` happens exactly once across a restart.
5. **Signals win over restart.** Operator SIGINT/SIGTERM during the
   restart window must not spawn a second engine (the existing
   `signalled` flag gates the restart branch).
6. **Restart re-runs the readiness gate.** Respawn → listen line →
   /health backoff, same deadlines, same fail-and-give-up paths. Reuse
   the existing boot sequence as a function rather than duplicating it.
7. **Banner = pure presentational over existing state** (I-4): a small
   `<ConnectionBanner />` rendered by App from `useSubscribe` status —
   visible for `reconnecting` (and `closed` after retries exhaust, if
   that state is reachable; verify in use-subscribe before pinning copy).
   `data-state` markers (I-3); no new wire events, no new hooks.
8. **No new spine contract.** Spine boots `createApp` in-process; the
   launcher supervises a *subprocess* engine — out of spine's frame.
   Restart behavior is pinned by launcher unit tests (fake harness);
   banner by a vitest dom test over a fake subscribe status. State the
   absence explicitly so nobody hunts for a missing T1.17.

## Tests

- **Launcher unit (bun, fake-driven):** death-after-ready → second spawn
  with pinned port + no second browser open + exit code of the *second*
  engine propagates; second death → no third spawn; death-before-ready →
  no restart (existing test still green); SIGINT during restart window →
  no respawn; restarted engine that never gets healthy → give-up exit 1.
- **Web (vitest dom):** ConnectionBanner renders per status variant;
  hidden when `open`.

## Commits

1. `docs(plans)`: this plan + INDEX row.
2. `feat(launcher)`: restart-once core (boot sequence extracted, pinned
   port, signal gating) + unit tests.
3. `feat(launcher)`: effects — `CLOD_UI_ENGINE_PORT` passthrough on respawn.
   (Fold into 2 if trivially small.)
4. `feat(web)`: ConnectionBanner + App wiring + dom test.
5. `docs`: land PR #22 — rotate plan, INDEX/README/CLAUDE.md; then PR #23
   (arch v3) starts as its own plan, or NEXT-SESSION.md hands it off.

## Deferred (named)

- `TODO(restart-policy)` — restart budgets/windows beyond once-per-lifetime.
- `TODO(pidfile)`, `TODO(ready-file)` — unchanged from PR #21.
- Sidebar/transcript refetch-on-reconnect, if reconnect alone proves
  insufficient after the banner lands — verify before building anything.
