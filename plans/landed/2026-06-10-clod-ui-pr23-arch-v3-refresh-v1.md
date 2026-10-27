# PR #23 — Architecture v3 refresh: the map matches the territory again

Date: 2026-06-10. Second half of the session strategy pinned in the
landed PR #22 plan. Docs-only slice: reconcile the architecture doc
against ~20 PRs of reality. Amend, don't rewrite-from-scratch.

## Decisions (pinned)

1. **v3 is a new file**, `plans/2026-06-10-clod-ui-architecture-v3.md`;
   v2 rotates to `docs/archive/` with a superseded banner — exactly the
   treatment v2's own Task 0.1 gave v1. Plans stay immutable; the
   correction is a new document, not an edit.
2. **Keep v2's section skeleton.** Same headings, same role (living
   spec + forward plan). A **drift ledger** section near the top lists
   every v2→v3 correction in one table so a reader of v2-era plans can
   map old claims to current truth without diffing.
3. **Phase checklists become status-marked** — landed (with PR #),
   partial, open — instead of all-`[ ]`. The unlanded phases (5, 6,
   7.1/7.2/7.5, 8) carry forward as plan, re-affirmed not redesigned.
4. **Corrections to pin** (verified against source this session):
   - Stack: Zustand + TanStack Query never adopted — discriminated-
     state hooks + pure reducers over the typed client (I-2/I-4) carry
     client state. chokidar never adopted — deliberate polling watcher.
     shiki + virtualization + Playwright not yet adopted (still
     candidates). `bun:sqlite` confirmed as-planned.
   - Wire: framed WS client→server messages (`subscribe`,
     `turn.submit`, `turn.cancel`, `resubscribe{since}`) never built.
     Reality: WS is a server→client event-plane; writes go over HTTP
     (`POST .../turns`, `POST .../cancel`); replay cursor is the
     `?since=` query param (T1.14). Event-kind list corrected to what
     the engine actually emits; wire-vs-manifest event split (I-8)
     documented.
   - Routes: no `POST/DELETE /conversations` (provisioning is
     implicit + idempotent via turn submission), `/settings` is global
     not per-conversation, `/attachments` + `/diagnostics` unbuilt;
     `GET .../transcript` + static SPA serving (opt-in 404 contract,
     I-1) exist instead.
   - Pidfile/single-instance (Task 2.9) never landed —
     `TODO(pidfile)`; graceful shutdown (2.10) landed.
   - Phase 7 status: 7.3 + 7.4 landed (launcher, restart-once w/
     pinned port, ConnectionBanner); 7.1/7.2/7.5 open.
   - CI: workflows exist; `ci:deep`/`ci:nightly` are stubs that run
     `ci:fast` + TODO logs. Perf budgets never ratified (T5 not run).
   - Living references that postdate v2: `docs/INVARIANTS.md`,
     `docs/SPINE.md`, `plans/INDEX.md` — v3 cites them instead of
     restating their content.
5. **Token discipline:** v3 stays in the same size class as v2 (~280
   lines). Drift ledger rows are one line each. No restating of
   INVARIANTS/SPINE content.
6. **Link updates:** `plans/INDEX.md` living-references row,
   `README.md` design links, `CLAUDE.md` architecture link → v3.

## Tests

None — docs-only. `ci:fast` still gates every commit (README
link-check covers the moved/added paths).

## Commits

1. `docs(plans)`: this plan + INDEX row.
2. `docs(plans)`: architecture v3 + v2 → archive + link updates.
3. `docs`: land PR #23 — rotate plan, INDEX, CLAUDE.md WIP,
   NEXT-SESSION.md rewrite (session close).

## Deferred (named)

- Phases 5/6/8 redesign — v3 re-affirms them as plan; any real
  redesign happens in their own PR plans when they come up.
- `TODO(protocol-doc)` — v2 Task 1.3 (`apps/engine/PROTOCOL.md`) was
  never written; v3 keeps it as an open task rather than silently
  dropping it.
