# Clod UI — Architecture & Implementation Plan (v2)

> **Superseded by [`plans/2026-06-10-clod-ui-architecture-v3.md`](../../plans/2026-06-10-clod-ui-architecture-v3.md)** (2026-06-10, PR #23). Kept for history; do not use for decisions. The v3 drift ledger records every correction.
>
> **Status:** This plan supersedes `plans/2026-04-23-clod-ui-initial-architecture-v1.md`. The v1 plan **must be moved to `docs/archive/`** before any other work begins (see Task 0.1). Future agent sessions should read only this v2 and the companion `plans/2026-04-23-clod-ui-test-strategy-v1.md`.
>
> **Companion plan:** `plans/2026-04-23-clod-ui-test-strategy-v1.md` defines the test strategy, layered pyramid, spine tests, and fake backends. Every phase below has a corresponding test-plan phase; implementation tasks land **with** their tests, and Phase T1 spine tests are authored **before** the Phase 2 engine code that satisfies them.

## Objective

Build **Clod UI**, a personal Claude chat UI that routes all model I/O through the **Claude Code CLI in headless mode**, keeping the user's subscription as the source of tokens and staying within Anthropic's first-party software ToS. The app is local-first in v1 but architected from day one as a **local daemon + SPA** so LAN and remote access are later flag-flips and auth additions, not rewrites. Quality is prioritized over ship speed; test-first for all timing- and IO-sensitive surfaces.

## Guiding Principles

- **CLI is the engine, UI is the cockpit.** No direct Anthropic API. Every model interaction spawns `claude -p --output-format stream-json --input-format stream-json` with the right flags.
- **Daemon + SPA from day one.** Engine and UI communicate over HTTP + WebSocket even on localhost. Same API surface for local, LAN, remote.
- **Sessions are first-class; transcripts are the CLI's.** Claude Code's per-session JSONL in `~/.claude/projects/<encoded-cwd>/<id>.jsonl` is the canonical transcript; we read-through it, we do not duplicate it.
- **Per-conversation cwd + append-only manifest.** Conversations own a directory. State changes (settings, attachments, artifacts, model switches) are appended to a `manifest.json` event log; current state is the fold.
- **Network-ready, not network-exposed.** v1 binds `127.0.0.1` only; auth, origin checks, and TLS are *written as seams* in v1 and *activated* in a later phase.
- **Typed contracts, typed everywhere.** Zod schemas in a shared package generate TS types for engine and UI alike. No stringly-typed fields crossing the process boundary.
- **Test-first for timing/IO.** Phase T1 spine tests exist and fail meaningfully before Phase 2 code is written.

## Recommended Stack

| Area | Choice | Note |
|---|---|---|
| Runtime | **Bun** | Engine and launcher; fast cold start, native TS, great subprocess story |
| Engine framework | **Hono** | Small, fast, excellent WS support, runs on Bun natively |
| Frontend tooling | **Vite + React 18 + TypeScript (strict)** | |
| Styling | **Tailwind CSS + shadcn/ui** | Copy-in components; no runtime framework lock-in |
| Client state | **Zustand** for chat-stream; **TanStack Query** for server-backed lists | Chat stream is event-driven, not request-response |
| Schemas | **Zod** in `@clod-ui/contracts`, shared by engine + UI | Single source of truth |
| Persistence | **SQLite** via `bun:sqlite` for conv index + settings index; **append-only JSONL** manifest per conversation | |
| File watching | **`chokidar`** (or Bun's `fs.watch` if sufficient) | For transcript tail |
| Markdown/code | `react-markdown` + `remark-gfm` + `shiki` | |
| Test — engine/integration/chaos/perf | **`bun:test`** | Native, fast, parallel |
| Test — UI components | **`vitest` + @testing-library/react** | Native to Vite |
| Test — E2E | **Playwright** | Trace viewer + strong MCP story |
| CI | **GitHub Actions** orchestrating **Bun scripts in `scripts/ci.ts`** | Pipelines reproducible locally |

## Repository Layout

```
clod-ui/
├── apps/
│   ├── engine/             # Bun + Hono daemon
│   ├── web/                # Vite + React SPA
│   └── launcher/           # Bun script: starts engine, opens browser
├── packages/
│   ├── contracts/          # Zod schemas + derived TS types (wire protocol)
│   ├── backend/            # ClaudeBackend trait + Real/Tape/Scripted/Chaos impls
│   ├── manifest/           # append-only event-log module
│   ├── settings/           # settings.json read/write + schema + atomic IO
│   └── test-kit/           # TestEnv harness, assertion helpers, fixtures API
├── tests/
│   ├── fixtures/
│   │   └── cli-tapes/
│   ├── e2e/                # Playwright
│   └── smoke/              # real-CLI gated tests (nightly)
├── docs/
│   └── archive/            # superseded plans live here
├── plans/                  # active plans only
├── scripts/
│   └── ci.ts               # Bun-scripted CI pipelines (source of truth)
├── .github/
│   └── workflows/          # thin shims calling scripts/ci.ts
├── package.json            # Bun workspaces root
└── tsconfig.base.json
```

## Wire Protocol (high level)

- **HTTP** for control-plane operations: list/create/delete conversations, PATCH settings, upload attachments, read-only fetches, health, diagnostics.
- **WebSocket** for the event-plane: a single persistent connection per UI, subscribing to conversation topics. Server pushes typed events; client sends turn submissions and cancellations as framed messages.
- **Event types** (enumerated in `@clod-ui/contracts`): `system.init`, `assistant.delta`, `assistant.complete`, `thinking.delta`, `thinking.complete`, `tool.use`, `tool.result`, `tool.error`, `turn.result`, `turn.error`, `turn.cancelled`, `transcript.updated`, `manifest.updated`, `settings.updated`, `conversation.created`, `conversation.deleted`, `health.changed`.
- **Replay window**: server buffers the last N events per conversation so a UI reload or transient disconnect can resume without loss; the client sends a `resubscribe{since: event_id}`.
- **Forward-compatible envelope**: every message carries a `v` (protocol version) and `kind`; unknown `kind`s are ignored with a warn-log, not crash.

## Conversation Directory Contract

```
<app-data>/conversations/<conv-uuid>/
  manifest.json    # append-only NDJSON; each line is a ManifestEvent
  cwd/             # handed to `claude` as its working directory
    attachments/   # user-provided files (canonical copies)
    artifacts/     # files claude creates/edits during the conversation
  scratch/         # ephemeral; wiped on cleanup; never referenced by manifest
```

- `manifest.json` is **NDJSON append-only**. Any in-place mutation is a bug and is detected by a monotonic `seq` + content hash chain.
- Projected state (`ConversationState`) is computed as a pure fold over the manifest; the SQLite row is a cache, not the truth.
- `cwd/` permission scoping is an orthogonal concern: whether `claude` may read/write outside `cwd/` is purely a function of the per-conversation tool/permission flags composed into each invocation.

## Implementation Plan

### Phase 0 — Hygiene, Monorepo, Foundations

- [ ] Task 0.1. **Archive the superseded v1 plan.** Move `plans/2026-04-23-clod-ui-initial-architecture-v1.md` to `docs/archive/2026-04-23-clod-ui-initial-architecture-v1.md` using `git mv` so history is preserved. Add a one-line note to the top of the moved file: "Superseded by `plans/2026-04-23-clod-ui-architecture-v2.md`." Rationale: prevents future agent sessions from ingesting stale stack choices (Tauri/Rust) and polluting context.
- [ ] Task 0.2. Initialize a Bun workspace monorepo with the layout above. Root `package.json` declares workspaces; each package has its own `package.json` + `tsconfig.json` extending `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Rationale: fixing the layout before code prevents path refactors later.
- [ ] Task 0.3. Configure ESLint + Prettier + import-sort at the root, shared across all packages. Commit hooks via `lefthook` (fast, Bun-friendly). Rationale: one lint config, zero drift.
- [ ] Task 0.4. Stand up `@clod-ui/contracts` with a minimal `HealthResponse` and `EventEnvelope` so downstream packages have something to import from day one. Rationale: contracts-first is the ethos; seeding it avoids a circular bootstrap problem.
- [ ] Task 0.5. Stand up `@clod-ui/test-kit` with a skeleton `TestEnv` that provisions temp dirs, ephemeral ports, and process-group cleanup. No real logic yet, just the surface. Rationale: every subsequent phase imports this; it has to exist before the spine tests do.
- [ ] Task 0.6. Land Phase T0 from the test strategy plan (infra) and Phase T1 (spine tests, written against a `NotImplemented` engine that fails every assertion). These tests are red on first commit **by design** and will stay red until Phase 2 lands. Rationale: this is the TDD handshake.
- [ ] Task 0.7. Write `scripts/ci.ts` with three entry points: `fast`, `deep`, `nightly`. Each calls into the layered runners. Wire three `.github/workflows/*.yml` files as thin shims invoking these scripts with the right matrix. Rationale: local and CI pipelines are literally the same code path; agents can reproduce CI failures with `bun run ci:fast`.

### Phase 1 — Contracts & Protocol

- [ ] Task 1.1. In `@clod-ui/contracts`, define Zod schemas for every wire type: `Event`, `TurnRequest`, `AttachmentRef`, `Conversation`, `ConversationSettings`, `Manifest*Event`, `Error`, `Health`, `Diagnostics*`. Derive TS types with `z.infer`. Rationale: one schema file per type, one TS type per schema, zero drift.
- [ ] Task 1.2. Generate a `@clod-ui/contracts/client` typed client factory: `createClient({transport})` returns HTTP methods + a WS subscriber with typed event handlers. The transport is an adapter interface (`LocalLoopback | LocalHttp | RemoteWS`). Rationale: transport-agnostic client lets tests and the real UI share code, and future LAN/remote work drops in without touching callers.
- [ ] Task 1.3. Document the protocol in `apps/engine/PROTOCOL.md` with a table of endpoints, event kinds, envelope shape, and replay semantics. This file is the human-readable complement to the Zod schemas. (Exception to "no unsolicited docs": this is a protocol spec, requested implicitly by the architecture.)
- [ ] Task 1.4. Define the `EventEnvelope` versioning rules: every envelope has `{v: 1, id, ts, kind, conv_id?, payload}`; unknown `kind` triggers a warn-log, not a throw, on both ends.

### Phase 2 — Engine Core (Bun + Hono)

> Phase T1 spine tests from the test-strategy plan must be green by the end of this phase.

- [ ] Task 2.1. Initialize `apps/engine` as a Bun + Hono app. Bind `127.0.0.1` by default, ephemeral port by default, with `--listen` and `--port` CLI flags *parsed but gated* (see Phase 8). Log startup with chosen port + a one-line banner. Rationale: localhost-only is the safe default; network is opt-in later.
- [ ] Task 2.2. Define the `ClaudeBackend` interface in `@clod-ui/backend`: `startTurn(opts): AsyncIterable<Event>`, `cancel(turnId): Promise<void>`, `version(): Promise<string>`, `health(): Promise<HealthStatus>`. Rationale: everything downstream speaks to this interface; real and test backends are peers.
- [ ] Task 2.3. Implement `RealClaudeBackend`: spawns `claude -p --output-format stream-json --input-format stream-json [flags...]` in its **own process group**, pipes stream-json input for the user turn, parses NDJSON stdout line-by-line into typed events, merges stderr (parsed + raw) into the same stream with error kinds. Records argv + env (redacted) into a diagnostics ring buffer. Rationale: process-group isolation is how we guarantee clean cancellation and no zombies.
- [ ] Task 2.4. Implement the **flag composer** in `@clod-ui/backend/compose`: pure function `(TurnRequest) => {argv: string[], env: Record<string,string>, stdin: Uint8Array}`. Centralizes every flag decision. Unit-tested exhaustively in Phase T2.1. Rationale: stringly-typed flag bugs are the #1 source of "why didn't my setting apply"; one pure function fixes that class of bug.
- [ ] Task 2.5. Implement the **cancel ladder**: `cancel()` sends `SIGINT`, waits `grace1` ms, `SIGTERM`, waits `grace2` ms, `SIGKILL`. Graces are configurable; defaults tuned in Phase T5. Emits `turn.cancelled` with the escalation level actually reached. Rationale: graceful first, guaranteed eventually.
- [ ] Task 2.6. Implement **stderr error taxonomy**: regex/JSON sniffers map stderr fragments to typed error kinds (`auth_failed`, `rate_limited`, `model_unavailable`, `tool_denied`, `mcp_unreachable`, `cli_missing`, `cli_unauthenticated`, `cli_crashed`, `transcript_corrupt`). Anything unmatched becomes `unknown` with the raw stderr attached. Rationale: typed errors drive typed UI affordances; raw stderr drives nothing useful.
- [ ] Task 2.7. Implement the Hono routes: `GET /health`, `GET /conversations`, `POST /conversations`, `GET /conversations/:id`, `DELETE /conversations/:id`, `PATCH /conversations/:id/settings`, `POST /attachments` (multipart), `GET /diagnostics`. Each validated end-to-end by Zod at the boundary. Rationale: narrow, validated surface.
- [ ] Task 2.8. Implement the WebSocket: single connection, topic subscription model, server-side per-conversation replay buffer (configurable window). Supports `subscribe`, `resubscribe{since}`, `turn.submit`, `turn.cancel`. Rationale: one WS beats N WS; replay buffer makes reload-during-stream painless.
- [ ] Task 2.9. Implement **pidfile + single-instance lock**: engine writes `<app-data>/engine.pid` on startup; a second engine with the same app-data dir refuses to start. On startup, a stale pidfile triggers a zombie-sweep of any lingering `claude` children from the previous run. Rationale: prevents the two-engines-one-DB catastrophe and reaps corpses.
- [ ] Task 2.10. Implement **graceful shutdown**: SIGINT/SIGTERM → stop accepting new turns, signal all in-flight backends to cancel, wait up to a budget, then exit. Unit-tested via ChaosBackend.

### Phase 3 — Persistence, Manifest, Transcripts

- [ ] Task 3.1. Define the SQLite schema and migrations (migration files numbered, forward-only): `conversations`, `conversation_settings`, `attachments_index`, `diagnostics_turns`. Use `bun:sqlite` with WAL mode. Rationale: migrations-from-day-one avoids the inevitable "ALTER TABLE in prod" pain.
- [ ] Task 3.2. Implement `@clod-ui/manifest`: `appendEvent(convId, event)` (atomic NDJSON append with `seq` + `hash_chain`), `readAll(convId)`, `fold(events)` → `ConversationState`. Verified append-only via a test that attempts in-place mutation and expects rejection. Rationale: append-only + hash chain is our tamper-evident log.
- [ ] Task 3.3. Implement **conversation provisioning**: creating a conversation mints a UUID, creates `<app-data>/conversations/<uuid>/{cwd,scratch}/`, writes the initial manifest events (`conversation.created`, `settings.applied`), and inserts the SQLite row. Rationale: atomic creation prevents half-formed conversations.
- [ ] Task 3.4. Implement **transcript reader** in `apps/engine/transcript`: given `(claude_session_id, cwd)`, locate the Claude Code JSONL file, tail it with `chokidar`, parse lines into normalized `ChatMessage`s, emit `transcript.updated` WS events. Handles renames/rotations defensively. Rationale: the JSONL is the model's view of history; our UI must match it.
- [ ] Task 3.5. Implement **auto-titling**: after the first `turn.result`, dispatch a secondary headless `claude -p` with a minimal prompt asking for a 4–6 word title; on failure or timeout, fall back to a date+first-words title. Rationale: scannable sidebar without user effort; failure is non-fatal.
- [ ] Task 3.6. Implement **`@clod-ui/settings`**: read/validate (Zod) `~/.claude/settings.json` and `<cwd>/.claude/settings.json`, atomic write (temp + fsync + rename), `.bak` rotation (last 3 kept), conflict detection (mtime check before overwrite). Rationale: we are editing user-owned config; corrupting it is unforgivable.

### Phase 4 — Web UI Scaffolding

- [ ] Task 4.1. Initialize `apps/web` with Vite + React + TS strict + Tailwind + shadcn/ui baseline (Button, Input, Textarea, Dialog, Tooltip, Select, Tabs, ScrollArea, Toast). Rationale: these cover 90% of what we need; add more as needed, not speculatively.
- [ ] Task 4.2. Wire the engine client from `@clod-ui/contracts/client` using the `LocalHttp` transport for HTTP + WS. A single `EngineProvider` React context exposes the client and reactive connection state. Rationale: one client instance per app; reconnection logic lives in one place.
- [ ] Task 4.3. Build the responsive 3-pane layout (sidebar / transcript / right inspector) with container queries; single-pane stack on narrow viewports; persistent layout state in localStorage. Rationale: fulfills the responsive-design requirement; container queries > viewport queries for component-level responsiveness.
- [ ] Task 4.4. Build the **streaming message renderer**: assistant text accumulated from `assistant.delta`; tool blocks from `tool.use`/`tool.result` rendered as collapsible cards; thinking blocks in a dim "Reasoning" collapsible; markdown via `react-markdown` + `shiki`; virtualized list for long transcripts. Rationale: the whole point of a custom UI.
- [ ] Task 4.5. Build the **composer**: multi-line textarea, `Enter` submit / `Shift+Enter` newline, paste + drag-drop attachment intake, attachment chip row, model/thinking/tools quick-access chips, inline activity pill. Rationale: biggest UX lever in any chat app.
- [ ] Task 4.6. Build the **activity pill** with states `idle | connecting | starting | thinking | tool:<name> | streaming | cancelling | error` derived from the event stream; Cancel button visible whenever non-idle. Rationale: spec requirement.
- [ ] Task 4.7. Build **error surfaces**: inline error bubbles at the point of failure with Retry, non-blocking toasts for ambient errors, a persistent banner when the engine is disconnected. Rationale: users must know when something is wrong without modal interruption.
- [ ] Task 4.8. Build **reconnect-and-resume**: on WS reconnect, client sends `resubscribe{since: last_event_id}`; renderer applies missed events without duplicates. Rationale: tab reloads and laptop-sleeps are normal; they must not lose state.

### Phase 5 — First-class Controls

- [ ] Task 5.1. **Model picker**: engine endpoint attempts dynamic discovery (parsing `claude --help` or a known config source) with a curated fallback list keyed by Claude Code version; UI shows a Select; per-conversation override + global default. Rationale: hardcoded lists rot.
- [ ] Task 5.2. **Thinking effort picker**: segmented control for `off | think | think hard | think harder | ultrathink`. Implementation encapsulated in one module that decides between prompt-suffix injection and `MAX_THINKING_TOKENS` env var, with a clear single-source-of-truth mapping. Rationale: isolating this means when Claude Code changes the mechanism, we change one file.
- [ ] Task 5.3. **System prompt block editor**: textarea per conversation, mode toggle `append | override`. Append is the default (safer w.r.t. subscription policies); override shows a dismissible warning. Live character count + rough token estimate. Rationale: spec requirement, with a ToS-conscious default.
- [ ] Task 5.4. **Preferences UI**: schema-aware form over global `~/.claude/settings.json` and the current project's `.claude/settings.json`. Validates against Zod schema before write; shows a diff preview; backs up prior file. Rationale: safe editing of files that live outside our app.
- [ ] Task 5.5. **Active tools editor**: checkbox list of built-in tools + MCP-discovered tools; Bash pattern chips with a small grammar helper; per-conversation override of a global default. Produces `--allowedTools`/`--disallowedTools` argv via the flag composer. Rationale: safety surface.
- [ ] Task 5.6. **Skills loader**: list skills discovered in `~/.claude/skills/` and `<cwd>/.claude/skills/`; per-conversation enabled set; behind a `SkillsBackend` trait so the enablement mechanism (settings mutation vs flag vs env) can evolve without UI churn. Rationale: the skills surface upstream is moving; abstract early.
- [ ] Task 5.7. **Diagnostics panel**: hidden-by-default; shows last N turns with argv (redacted), env (redacted), stdin size, event timeline, exit code, and a "Copy repro" that exports a standalone JSON that test-kit can consume to reproduce the backend invocation. Rationale: the single most useful tool when something goes wrong.
- [ ] Task 5.8. **Raw-flags escape hatch**: an advanced-settings field for appending arbitrary argv. Disabled by default, warning visible when enabled. Rationale: when our abstractions lag Claude Code upstream, power users aren't blocked.

### Phase 6 — Attachments

- [ ] Task 6.1. **Intake pipeline**: drag-drop, clipboard paste, and file-picker → engine `POST /attachments` (multipart) → copied to `<conv>/cwd/attachments/` with a content-hashed filename → row in `attachments_index` + manifest event → `AttachmentRef` returned to UI. Per-file and total-payload limits enforced. Rationale: canonical copies + stable paths are a prereq for resume/replay.
- [ ] Task 6.2. **Image handling**: detect installed Claude Code's preferred image content-block form (base64 vs file-ref) at engine startup; construct `stream-json` input accordingly; client-side downscale images above a configurable max edge; show estimated token cost in the chip. Rationale: images must arrive as model-visible content blocks, not just file paths.
- [ ] Task 6.3. **File handling (non-image)**: attach by reference — the composed user message cites the file path, and the flag composer permits `Read` on that path for the turn. Rationale: tool-driven retrieval is the Claude Code-native pattern; beats inlining huge bodies.
- [ ] Task 6.4. **Cleanup + orphan sweeper**: deleting a conversation purges its directory; a maintenance command walks `<app-data>/conversations/` and reports files not referenced by any manifest. Rationale: disk hygiene.

### Phase 7 — Polish & Resilience

- [ ] Task 7.1. Keyboard map: `Cmd+K` quick switcher, `Cmd+N` new conversation, `Cmd+/` focus composer, `Esc` cancel, `Cmd+,` settings, `Cmd+Shift+D` diagnostics.
- [ ] Task 7.2. Theme: light / dark / system, honest dark mode, persisted in prefs.
- [ ] Task 7.3. **Launcher** (`apps/launcher`): starts engine as a child process, polls `/health` with timeout + backoff, opens default browser to the engine URL, forwards SIGINT to the engine on exit. Uses the same pidfile hygiene as the engine. Rationale: one command → working app.
- [ ] Task 7.4. **Crash recovery**: mid-stream subprocess death → `turn.error{kind: cli_crashed, retryable: true}` + clean state; engine crash → launcher auto-restarts once and shows a disconnected banner in UI until reconnected. Rationale: "it came back" beats "please restart."
- [ ] Task 7.5. Structured logging: rotating file logs under `<app-data>/logs/`; levels configurable via env; default level excludes message bodies and argv secrets. Rationale: debuggability without PII risk.

### Phase 8 — Network-Readiness Activation (local-only still default)

> These tasks activate seams already present from Phase 2. v1 ships local-only; this phase is gated behind an explicit user opt-in.

- [ ] Task 8.1. Implement the **auth token module**: generate a per-install token on first run, stored in `<app-data>/auth.token` (0600); engine accepts requests only with `Authorization: Bearer <token>` when bound to non-loopback; loopback bypass stays the default for the common case. Rationale: one-line flag flip enables LAN safely.
- [ ] Task 8.2. Implement **WS origin + CSRF checks**: WS upgrade rejects unexpected `Origin` when network mode is on; HTTP mutating routes require a CSRF header double-submit. Rationale: standard web defenses, off by default in loopback-only mode.
- [ ] Task 8.3. Implement **TLS helper**: a `bun run tls:setup` script using `mkcert` generates a locally-trusted cert; engine reads cert/key paths from config when `--tls` is passed. Rationale: LAN without TLS is not a serious option.
- [ ] Task 8.4. Un-skip the Phase T6 network-mode tests (auth enforcement, origin rejection, token rotation grace window) and make them green. Rationale: the placeholder tests become the acceptance gate for this phase.
- [ ] Task 8.5. **QR-code pairing helper** (optional, nice-to-have): a "Pair a device" dialog shows a QR encoding `https://<lan-ip>:<port>/?t=<one-time-token>` that redeems for the real token on first connect. Rationale: phone/tablet onboarding without typing tokens.

## CI Design

- **Source of truth:** `scripts/ci.ts` (Bun). Exposes `fast`, `deep`, `nightly` entry points that run the layered suites from the test-strategy plan. All developer and CI runs go through this script; no pipeline logic lives in YAML.
- **GitHub Actions workflows** (`.github/workflows/`):
  - `fast.yml` — on every push and PR. Runs `bun run ci:fast` (L2 + L3 + L4). Budget: <2 min on a standard runner.
  - `deep.yml` — on PRs targeting `main`. Runs `bun run ci:deep` (adds L5 + L7 + L8). Budget: <15 min.
  - `nightly.yml` — scheduled. Runs `bun run ci:nightly` (adds L1 contract tapes + L6 real-CLI smoke + flake-detection shuffle). macOS runner for L6 since `claude` is primarily installed there.
- **Caches:** Bun install cache, Playwright browser cache, tape fixture cache (keyed by Claude Code version).
- **Artifacts on failure:** Playwright traces, engine diagnostics dumps, tape diffs, failing JSONL fixtures.
- **Agent ergonomics:**
  - Anthropic's **Claude Code GitHub Action** wired for `@claude` PR mentions.
  - The **`gh` MCP server** is assumed available for agent sessions; agents can read run logs, rerun failed jobs, annotate PRs.
  - A future `/ci` skill (deferred, not blocking) that wraps local CI + log triage.

## Provisional Performance Budgets (to be ratified after first real runs)

Each target carries its *why* so we know which assumption to challenge after measurement.

| Metric | Provisional target | Rationale |
|---|---|---|
| Engine cold start (spawn → `/health` ok) | **< 500 ms** | Bun cold starts are routinely <200ms; adding SQLite open + Hono bind + `claude --version` check, 500ms is comfortable. |
| First assistant delta latency (turn submit → first `assistant.delta` in UI) | **< 300 ms overhead** above what `claude -p` itself delivers | We add subprocess spawn + NDJSON parse + WS hop; each should be single-digit ms; 300ms leaves margin. |
| Streaming throughput | **≥ 5,000 deltas/sec** sustained, end-to-end to a rendered (virtualized) UI | NDJSON parsing in Bun can do >100k lines/sec; the UI virtualization is the realistic bottleneck; 5k is conservative-optimistic. |
| Large transcript open (5 MB JSONL) | **< 400 ms to first paint**, **< 150 ms to scroll-to-bottom** | Virtualization + tail-read should make transcript size nearly irrelevant to first paint; 400ms is generous. |
| Attachment pipeline (50 MB image drop → send-ready) | **< 1.5 s** including downscale | Image downscale is the dominant cost; 50MB JPEG decode + resize is typically ~800ms on modern laptops. |
| Cancel ladder wall-clock (submit cancel → `idle`) for a well-behaved CLI | **< 200 ms** | One SIGINT + exit should resolve quickly; ladder only escalates on misbehavior. |
| Fast-pipeline CI wall-clock | **< 2 min** | Inner-loop feedback must be sub-coffee; parallelize bun:test files and vitest. |
| Deep-pipeline CI wall-clock | **< 15 min** | PR latency ceiling before reviewers context-switch away. |

> These numbers are starting targets. First real measurement run happens at Phase T5 kickoff; any target off by >2x triggers a "what assumption was wrong" retro entry before adjusting.

## Verification Criteria

- v1 architecture plan is physically at `docs/archive/...` and referenced nowhere in `plans/`.
- Running `bun run start` (launcher) on a clean machine with `claude` installed and authenticated opens a browser to a working UI within the cold-start budget.
- Creating a new conversation and sending a turn produces a streaming response; closing and reopening the app resumes the conversation correctly via `--resume`.
- Each first-class control (model, thinking effort, system prompt mode, tool allowlist, skills) measurably changes the spawned argv, confirmed via the diagnostics panel's "Copy repro."
- At least one image attachment and one non-image file attachment can be referenced by the assistant in its reply.
- The activity pill visibly traverses `idle → starting → thinking → tool:* → streaming → idle`; Cancel reliably interrupts within the cancel-ladder budget.
- Known error classes from the taxonomy each render an actionable inline message, never a raw stack trace.
- Layout remains usable at 360px → 2560px viewport widths; sidebar collapses below threshold.
- Settings edits in the UI produce schema-valid files on disk with `.bak` of the prior version.
- No outbound network connection to `api.anthropic.com` from the app (verifiable by process-level network inspection and source audit); the only outbound subprocess is `claude`.
- Phase T1 spine tests and all non-skipped T2–T5 tests are green in the fast and deep pipelines.
- Phase T6 (network-mode) tests remain `skip` until Phase 8; activating Phase 8 flips them to required.

## Potential Risks and Mitigations

1. **Claude Code CLI surface evolves** (flags, event shapes, skills mechanism).
   Mitigation: `ClaudeBackend` + `SkillsBackend` abstractions; nightly L1 contract tapes detect drift; raw-flags escape hatch (Task 5.8) unblocks users while we catch up; minimum-supported-version check at startup.

2. **Bun as a still-evolving runtime** hits a sharp edge (subprocess quirks, WS edge cases).
   Mitigation: pin Bun version in `package.json` and CI; keep the engine's subprocess and WS code behind a thin adapter so porting to Node is a last-resort day of work, not a rewrite.

3. **Subscription ToS interpretation around system-prompt override.**
   Mitigation: default to *append* mode; override mode is opt-in with a warning; no autonomous multi-turn loops in v1; document the stance in the About screen.

4. **Per-conversation cwd becomes a footgun** if users accidentally delete conversations with important artifacts.
   Mitigation: delete is soft (move to `<app-data>/trash/`) with a 7-day window; "Open conversation folder" menu item; explicit "Artifacts: N files" indicator in the sidebar.

5. **Long-running tool calls leaving zombies** on crash.
   Mitigation: process-group spawn; pidfile + startup zombie sweep; `expectNoZombies()` assertions in chaos tests.

6. **JSONL transcript files can be huge.**
   Mitigation: virtualization; tail-reads; summarize/archive old turns in the sidebar without dropping them on disk.

7. **Attachment payloads blow up token usage** silently.
   Mitigation: client-side downscale; per-chip token estimate; configurable caps with clear UI feedback before send.

8. **Editing user-owned `settings.json`** risks corrupting broader Claude Code setup.
   Mitigation: Zod validation before write; atomic write (temp + fsync + rename); `.bak` rotation; "Restore previous settings" UI action; mtime conflict detection.

9. **Network-mode activation misconfiguration** (accidentally exposing without auth).
   Mitigation: non-loopback bind *requires* auth token presence, enforced at startup — engine refuses to listen on a non-loopback address without a valid token file; test T6.2 is the gate.

10. **Two engines racing on the same app-data dir.**
    Mitigation: pidfile + fcntl-style lock; second instance exits with a clear "already running on port X" message pointing to the live one.

## Alternative Approaches

1. **Electron instead of Bun-engine + browser.** Pros: largest ecosystem, dock-icon out of the box. Cons: heavy binary, weaker security defaults, no natural network-access path, more RAM. Not recommended given the local-daemon architecture wins we get for free.

2. **Node + Fastify instead of Bun + Hono.** Pros: most mature runtime, broadest library support. Cons: slower cold start, heavier install, loses the "one runtime, one language" simplicity. Viable fallback if Bun trips us up in Phase 2.

3. **Single-runner testing (`vitest` everywhere) instead of split bun:test/vitest.** Pros: one mental model, one config. Cons: vitest under Bun adds a transpile hop, and we lose bun:test's parallelism on the engine side. Defensible if we hit real friction but starts from a slower baseline.

4. **Tauri wrapper layered on top of the daemon + SPA** as an optional desktop shell. Not needed for v1, but compatible with this architecture: Tauri would just launch the same Bun engine and load the web app into its webview. Available any time as a later addition without touching the core.

## Open Assumptions

- **macOS-first** target; Bun + Playwright + `mkcert` all work cleanly on macOS; Linux/Windows are a "probably fine, not a focus" commitment.
- **Single user, single machine** in v1; LAN in Phase 8; remote/multi-user never (by scope).
- **No telemetry, no analytics, no auto-update** in v1.
- **No conversation export** in v1; the JSONL + manifest files are already on disk and portable.
- **`claude` CLI authentication is user-responsibility**; we detect and surface its absence but do not drive `claude login`.
- **Bun version is pinned**; upgrades are intentional, not automatic.
- **GitHub is the VCS host**; self-hosted Forgejo/Gitea would work (their Actions are GH-compatible) but is not a design driver.
