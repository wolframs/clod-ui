# Plans index

This directory holds the architecture plan, the test strategy, and active
PR plans. Landed plans (one per shipped PR) live under [`landed/`](./landed/).

Naming convention: `YYYY-MM-DD-clod-ui-<pr-or-doc>-v<N>.md`.

---

## Living references

| File | Surface |
|---|---|
| [`2026-04-23-clod-ui-architecture-v2.md`](./2026-04-23-clod-ui-architecture-v2.md) | Project architecture spec. v2 of 2026-04-23. Refresh to v3 queued for ~PR #20. |
| [`2026-04-23-clod-ui-test-strategy-v1.md`](./2026-04-23-clod-ui-test-strategy-v1.md) | Test pyramid + spine contract; ci:fast/deep/nightly tier definitions. |

## Active plans

| File | PR | Surface |
|---|---|---|
| [`2026-05-02-clod-ui-pr19-1-inspection-cleanup-v1.md`](./2026-05-02-clod-ui-pr19-1-inspection-cleanup-v1.md) | #19.1 | Post-streaming-arc inspection sweep: useSubmitTurn conv-id reset bug + plan rotation + drift refresh. |

## Landed (shipped PRs)

| PR | File | Surface |
|---|---|---|
| #1 | [`pr1-foundation-v2`](./landed/2026-04-23-clod-ui-pr1-foundation-v2.md) | Bun monorepo scaffold + 12 spine tests (skipped) + ci:fast/deep wiring. |
| #2 | [`pr2-health-probe-v1`](./landed/2026-04-23-clod-ui-pr2-health-probe-v1.md) | `GET /health` wired to a real CLI probe + `T1.12` un-skipped. |
| #3 | [`pr3-flag-composer-v1`](./landed/2026-04-23-clod-ui-pr3-flag-composer-v1.md) | Pure flag composer + `T1.02` un-skipped (resume passes flags). |
| #4 | [`pr4-real-startturn-v1`](./landed/2026-04-23-clod-ui-pr4-real-startturn-v1.md) | `RealClaudeBackend.startTurn` + WS broadcast + `T1.04` un-skipped (streaming ordering). |
| #5 | [`pr5-cancel-ladder-and-taxonomy-v1`](./landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md) | SIGINT→SIGTERM→SIGKILL ladder + error classifier + spine T1.05–T1.08. |
| #6 | [`pr6-sqlite-manifest-v1`](./landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md) | SQLite + `ManifestStore` (hash-chain, append-only) + provisioning + T1.01b/T1.03/T1.10 un-skipped. |
| #7 | [`pr7-transcript-watcher-v1`](./landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md) | `@clod-ui/transcripts` + `TranscriptWatcher` + `transcript.updated` wire event + T1.11 un-skipped. |
| #8 | [`pr8-settings-roundtrip-v1`](./landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md) | `@clod-ui/settings` (atomic IO + `.bak` rotation) + `GET/PUT/PATCH /settings` + T1.09 un-skipped. |
| #9 | [`pr9-chatmessage-normalization-v1`](./landed/2026-04-24-clod-ui-pr9-chatmessage-normalization-v1.md) | `ChatMessage` schema + `normalizeTranscriptLines` pure transform. |
| #10 | [`pr10-auto-titling-v1`](./landed/2026-04-25-clod-ui-pr10-auto-titling-v1.md) | `conversation.titled` event kind + `Titler` interface + `FallbackTitler` + engine wiring. |
| #11 | [`pr11-default-titler-v1`](./landed/2026-04-26-clod-ui-pr11-default-titler-v1.md) | `DefaultTitler` (`claude -p` + Haiku) with fallback delegation. |
| #12 | [`pr12-conversations-list-v1`](./landed/2026-04-27-clod-ui-pr12-conversations-list-v1.md) | `GET /conversations` sidebar projection + `ConversationSummary` + T1.13. |
| #13 | [`pr13-typed-client-v1`](./landed/2026-04-28-clod-ui-pr13-typed-client-v1.md) | `@clod-ui/contracts/client` + `LocalHttpTransport` + `createClient` factory. |
| #14 | [`pr14-engine-provider-v1`](./landed/2026-04-29-clod-ui-pr14-engine-provider-v1.md) | React `EngineProvider` + `useEngine()` + `useHealth` + `HealthBadge`. |
| #15 | [`pr15-vitest-rtl-v1`](./landed/2026-04-29-clod-ui-pr15-vitest-rtl-v1.md) | Vitest + happy-dom + RTL infrastructure inside `apps/web`. |
| #16 | [`pr16-sidebar-v1`](./landed/2026-04-29-clod-ui-pr16-sidebar-v1.md) | `<Sidebar />` + `useConversations` + `relativeTime` + 2-column layout. |
| #16.5 | [`pr16-5-cleanup-v1`](./landed/2026-04-30-clod-ui-pr16-5-cleanup-v1.md) | Pre-streaming-arc cleanup: plans index, invariants doc, spine catalog, engine route split, ErrorBoundary. |
| #17 | [`pr17-reconnect-and-resume-v1`](./landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md) | `ReplayBuffer` + `?since=` cursor + reconnect state machine + typed event dispatch + T1.14. |
| #17.1 | [`pr17-1-replay-schema-and-reconnect-integration-v1`](./landed/2026-04-30-clod-ui-pr17-1-replay-schema-and-reconnect-integration-v1.md) | `ReplayStartPayloadSchema` + transient WS-drop integration test. |
| #18a | [`pr18a-use-subscribe-v1`](./landed/2026-04-30-clod-ui-pr18a-use-subscribe-v1.md) | `useSubscribe` hook — discriminated state, ref-stable handlers, StrictMode-safe. |
| #18b | [`pr18b-use-turn-stream-v1`](./landed/2026-05-01-clod-ui-pr18b-use-turn-stream-v1.md) | `turnReducer` (pure) + `useTurnStream` hook — streaming-turn projection. |
| #18c | [`pr18c-turn-view-v1`](./landed/2026-05-02-clod-ui-pr18c-turn-view-v1.md) | `<TurnView />` pure presentational projection + sub-components (AssistantMessage / ThinkingBlock / ToolCard / TurnStatusPill / UsageBadge). |
| #19 | [`pr19-composer-v1`](./landed/2026-05-02-clod-ui-pr19-composer-v1.md) | `useSubmitTurn` + `<Composer />` + Sidebar `+ New` button — closes the read/write loop. |

## Conventions

- One plan per PR. Author the plan first, ship the impl, leave the plan in
  place. The plan is the source of truth for *why*; the code is the source
  of truth for *what*.
- Plans are immutable after their PR ships — corrections happen in the
  next plan ("PR #N revises the §X decision from PR #M because...").
- When `plans/` (active dir) approaches ~5 entries and PR #N has
  shipped, rotate `pr<N>-*-v1.md` into `landed/` and update this index.
