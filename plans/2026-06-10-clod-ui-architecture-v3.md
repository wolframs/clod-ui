# Clod UI — Architecture & Implementation Plan (v3)

> **Status:** This plan supersedes `docs/archive/2026-04-23-clod-ui-architecture-v2.md` (authored 2026-04-23, refreshed 2026-06-10 after PR #22). v2 described the project before any code existed; this v3 reconciles the spec with ~20 landed PRs. Where v2 and reality disagreed, **reality won** — the drift ledger below records every correction. Unlanded phases (5, 6, 7.1/7.2/7.5, 8) carry forward as plan, re-affirmed not redesigned.
>
> **Companion references:** `plans/2026-04-23-clod-ui-test-strategy-v1.md` (test pyramid, CI tiers), `docs/INVARIANTS.md` (the 9 load-bearing contracts, cited as I-1…I-9 below), `docs/SPINE.md` (canonical catalog of the 30 spine contracts), `plans/INDEX.md` (every PR plan). This doc does not restate their content.

## Drift ledger (v2 → v3)

What v2 specified vs. what got built. Each row is a deliberate correction, not an erratum — the landed PR plans carry the *why*.

| v2 said | Reality (v3) | Where |
| --- | --- | --- |
| Zustand for chat-stream, TanStack Query for lists | Neither adopted. Discriminated-state hooks (I-2) + pure reducers (`turnReducer`) over the typed client carry all client state | PR #18a/b, #14 |
| `chokidar` for transcript tail | Deliberate polling watcher (`node:fs` + interval); deterministic across platforms | PR #7 |
| `shiki` for code highlighting | Not yet adopted; `react-markdown` + `remark-gfm` with a styled component map, HTML stays escaped | PR #18d.2 |
| Virtualized transcript list | Not yet; single scroll container + sticky-bottom | PR #18d.1 |
| WS carries framed client→server messages (`subscribe`, `turn.submit`, `turn.cancel`, `resubscribe{since}`) | Never built. WS is a server→client event-plane only; writes go over HTTP; replay cursor is the `?since=` query param | PR #4, #17, T1.14 |
| `POST /conversations`, `DELETE /conversations/:id`, `PATCH /conversations/:id/settings`, `POST /attachments`, `GET /diagnostics` | None of these. Provisioning is implicit + idempotent on turn submission; `/settings` is global; attachments/diagnostics unbuilt (Phases 5/6) | PR #6, #8 |
| Event kinds incl. `manifest.updated`, `settings.updated`, `conversation.deleted`, `health.changed` | Never emitted. See the corrected kind list below; wire vs. manifest events are distinct vocabularies (I-8) | docs/INVARIANTS.md |
| Pidfile + single-instance lock (Task 2.9), "launcher uses the same pidfile hygiene" | Never landed; `TODO(pidfile)` in launcher + engine. Launcher port discovery parses the engine's listen line instead (`TODO(ready-file)`) | PR #21 |
| `apps/engine/PROTOCOL.md` (Task 1.3) | Never written; `TODO(protocol-doc)`. The Zod schemas + docs/SPINE.md are the protocol's source of truth today | — |
| CI tiers fast/deep/nightly all live | Workflows exist; `ci:deep`/`ci:nightly` run `ci:fast` then exit 0 with TODO logs | scripts/ci.ts |
| Performance budgets ratified at Phase T5 | T5 never ran; budgets remain provisional and unmeasured | — |
| Test split bun:test (engine) / vitest (UI components) | Split is by *file location*, not package: bun owns everything except `apps/web/tests/dom/**` (vitest + happy-dom). Stateless components test via `renderToString` on the bun tier | PR #15 |

## Objective

Build **Clod UI**, a personal Claude chat UI that routes all model I/O through the **Claude Code CLI in headless mode**, keeping the user's subscription as the source of tokens and staying within Anthropic's first-party software ToS. The app is local-first but architected as a **local daemon + SPA** so LAN and remote access are later flag-flips and auth additions, not rewrites. Quality over ship speed; test-first for timing- and IO-sensitive surfaces. *(Unchanged from v2; this has held.)*

## Guiding Principles

*(Unchanged from v2 — all seven have held across 20+ PRs.)*

- **CLI is the engine, UI is the cockpit.** No direct Anthropic API.
- **Daemon + SPA from day one.** HTTP + WS even on localhost; in production the engine also serves the built SPA same-origin (PR #21).
- **Sessions are first-class; transcripts are the CLI's.** Read-through, never duplicate (I-9: one parser, identical wire shape).
- **Per-conversation cwd + append-only manifest.** Current state is the fold (I-7: fold purity vs. engine policy).
- **Network-ready, not network-exposed.** `127.0.0.1` only until Phase 8.
- **Typed contracts, typed everywhere.** Zod in `@clod-ui/contracts`; no stringly-typed fields across the boundary.
- **Test-first for timing/IO.** The spine (30 contracts, 16 files) gates every commit.

## Stack (as built)

| Area | Choice | Note |
| --- | --- | --- |
| Runtime | **Bun** (pinned in `.bun-version`) | Engine, launcher, test runner |
| Engine framework | **Hono** | |
| Frontend | **Vite + React 18 + TS strict** | |
| Styling | **Tailwind + shadcn-style copy-in primitives** | |
| Client state | **Discriminated-state hooks + pure reducers** (I-2, I-4) | No state library; the typed client + `useSubscribe`/`useTurnStream` et al. are the seam |
| Schemas | **Zod** in `@clod-ui/contracts` | Single source of truth |
| Persistence | **`bun:sqlite`** (index/cache) + **append-only NDJSON manifest** (truth) | As planned |
| Transcript tail | **Polling watcher** over `node:fs` | chokidar rejected for determinism |
| Markdown | `react-markdown` + `remark-gfm`, styled map, HTML escaped | shiki still a candidate, not adopted |
| Tests | **bun:test** (all but `apps/web/tests/dom/**`) + **vitest/happy-dom/RTL** (dom tier) | Split by file location |
| E2E | Playwright **(planned, not adopted)** | Lands with ci:deep de-stubbing |
| CI | `scripts/ci.ts` (`fast` live; `deep`/`nightly` stubbed) + thin GH Actions shims | |

## Repository Layout

*(As v2 planned, plus what accreted — see CLAUDE.md's file map for the per-file tour.)* Notable additions since v2: `packages/transcripts/` (own package, not an engine module), `tests/spine/` at the root (not per-app), `docs/INVARIANTS.md` + `docs/SPINE.md`, `plans/landed/`.

## Wire Protocol (as built)

- **HTTP (control-plane + writes):** `GET /health` (always-on), `GET /conversations`, `POST /conversations/:id/turns`, `POST /conversations/:id/cancel`, `GET /conversations/:id/transcript`, `GET/PUT/PATCH /settings` (global), static SPA catch-all. Opt-in subsystems return `404 {error: '<surface> not configured'}` when unwired (I-1).
- **WebSocket (event-plane, server→client only):** one subscription per client; the server pushes typed `EventEnvelope`s. Clients never send framed messages — turn submission and cancellation are HTTP POSTs. This is simpler than v2's design and has cost nothing so far.
- **Wire event kinds (as emitted):** `system.init`, `assistant.delta`, `assistant.complete`, `thinking.delta`, `thinking.complete`, `tool.use`, `tool.result`, `tool.error`, `turn.result`, `turn.error`, `turn.cancelled`, `transcript.updated`, `conversation.titled`, plus the replay-start sentinel. Manifest events (`conversation.created`, `session.captured`, `settings.applied`, `conversation.titled`…) are a separate vocabulary that never crosses the wire directly (I-8).
- **Replay:** bounded ring buffer per engine; reconnect resumes via `?since=<last_event_id>` on the WS URL (T1.14 pins the gap case). The envelope carries `{v, id, ts, kind, conv_id, payload}`; unknown kinds warn-log, never throw.
- **Error taxonomy:** typed `ClodError` kinds (`auth_failed`, `rate_limited`, `model_unavailable`, `tool_denied`, `mcp_unreachable`, `cli_missing`, `cli_unauthenticated`, `cli_crashed`, `transcript_corrupt`, `conversation_busy`, `provisioning_failed`, `settings_corrupt`, `settings_invalid`, `unknown`) — broader than v2's list because reality demanded more kinds.

## Conversation Directory Contract

*(Unchanged from v2 in design; `attachments/`, `artifacts/`, `scratch/` semantics activate with Phase 6.)* `manifest.json` is NDJSON append-only with `seq` + hash chain; projected state is a pure fold; the SQLite row is a cache, not the truth. All landed (PR #6) and spine-pinned.

## Implementation Status

### Landed (PR cross-refs in `plans/INDEX.md`)

- **Phase 0 — hygiene/monorepo/CI skeleton** (PR #1). Deviation: spine tests landed *skipped*, un-skipped PR-by-PR, rather than red-by-design.
- **Phase 1 — contracts & protocol** (PRs #1, #13). Typed client + `LocalHttpTransport` + `createClient`. Open: `TODO(protocol-doc)` (v2 Task 1.3).
- **Phase 2 — engine core** (PRs #2–#5). Real backend, flag composer, cancel ladder, error taxonomy, graceful shutdown. **Not landed: Task 2.9 pidfile/single-instance (`TODO(pidfile)`)**; WS framed client messages dropped (see drift ledger).
- **Phase 3 — persistence/manifest/transcripts** (PRs #6–#11). SQLite + manifest fold + provisioning + polling watcher + settings + auto-titling (fire-and-forget worker with double-check, I-5).
- **Phase 4 — web UI** (PRs #12, #14–#20b, #18d.x). 2-column layout (3-pane + inspector deferred with `TODO(layout-state)`), streaming renderer with collapsible tool/thinking cards, markdown, composer with cancel, reconnect-and-resume, transcript history, sticky-bottom scroll. No virtualization yet; no attachments UI (Phase 6).
- **Phase 7.3 — launcher** (PR #21). `bun run start` → builds web dist if missing, spawns engine (serving the SPA same-origin via `CLOD_UI_STATIC_DIR`), parses the listen line, polls `/health` with backoff, opens browser, forwards signals via the SIGINT→SIGTERM→SIGKILL ladder.
- **Phase 7.4 — crash recovery** (PRs #5, #22). CLI-subprocess death → `turn.error{kind: cli_crashed, retryable: true}` (T1.07). Engine death after ready, no operator signal, non-zero exit → launcher restarts once on the pinned port (`CLOD_UI_ENGINE_PORT`); web shows `<ConnectionBanner />` from the stream's own connection state. `TODO(restart-policy)` for anything beyond once-per-lifetime.

### Open (carried forward as plan, re-affirmed not redesigned)

- **Phase 5 — first-class controls** (model picker, thinking effort, system-prompt editor, preferences UI, tools editor, skills loader, diagnostics panel, raw-flags escape hatch). The flag composer (PR #3) is the substrate; everything here composes onto it.
- **Phase 6 — attachments** (intake pipeline, image content-blocks, file-by-reference, cleanup/orphan sweeper).
- **Phase 7.1 / 7.2 / 7.5** — keyboard map; honest dark mode; structured logging.
- **Phase 8 — network-readiness activation** (auth token, origin/CSRF, TLS helper, T6 un-skip, QR pairing). Still gated on explicit opt-in; still "seams written, not activated."
- **CI de-stubbing** — `ci:deep` (Playwright, chaos), `ci:nightly` (L1 contract tapes, real-CLI smoke, flake shuffle) per the test-strategy plan.
- **Performance budgets** — v2's table remains *provisional and unmeasured*; ratification happens at Phase T5 kickoff (unscheduled). Budgets off by >2× still trigger a what-assumption-was-wrong retro.

## Conventions that hardened after v2

These postdate v2 and are now load-bearing; `docs/INVARIANTS.md` is canonical:

- Opt-in 404 contract (I-1); discriminated state hooks (I-2); `data-state`/`data-test` markers (I-3); pure presentational components (I-4); fire-and-forget worker with double-check (I-5); atomic IO (I-6); fold purity vs. engine policy (I-7); wire-only vs. manifest events (I-8); shared transcript parser (I-9).
- "Adjust state on prop change" (not useEffect) for hooks keyed on changing props (PR #19.1).
- The PR cadence itself: plan → contracts → pure logic → wiring → spine → 3–5 commits, `ci:fast` green before each (see CLAUDE.md).

## Verification Criteria (status)

- ✅ v1/v2 plans archived; `bun run start` on a clean machine opens a working UI; conversation create + streaming turn + cancel land end-to-end; no outbound `api.anthropic.com` connection; spine green on every commit; engine crash recovery verified live.
- ⏳ Resume via `--resume` across app restarts (wired; resume-correctness has spine coverage via flag composition, no e2e yet); first-class controls changing argv observably (Phase 5); attachments (Phase 6); 360px→2560px responsiveness (untested below desktop widths); settings-edit `.bak` verification in UI (engine layer landed, no UI).
- ◻ Phase T6 network tests stay skipped until Phase 8.

## Risks (delta from v2)

v2's ten risks stand. Two adjustments:

1. **Risk 2 (Bun sharp edges) has partially materialized** — DOM-lib type friction with Bun's ReadableStream iterator (PR #21), `bun:sqlite`/better-sqlite3 ambiguity. All absorbed by thin adapters as planned; the mitigation works.
2. **New risk: doc drift.** This v3 exists because the spec went stale within ~20 PRs. Mitigation: the INDEX "Living references" table is the canonical entry point; refresh the architecture doc when its drift ledger would exceed ~5 rows, not on a PR-number schedule.

## Open Assumptions

*(Unchanged from v2: macOS-first, single user/machine, no telemetry, no export, CLI auth is user-responsibility, Bun pinned, GitHub-hosted.)*
