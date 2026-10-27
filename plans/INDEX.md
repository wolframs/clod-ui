# Plans index

This directory holds the architecture plan, the test strategy, and active
PR plans. Landed plans (one per shipped PR) live under [`landed/`](./landed/).

Naming convention: `YYYY-MM-DD-clod-ui-<pr-or-doc>-v<N>.md`.

---

## Living references

| File | Surface |
|---|---|
| [`2026-06-10-clod-ui-architecture-v3.md`](./2026-06-10-clod-ui-architecture-v3.md) | Project architecture spec. v3 of 2026-06-10 (PR #23) — drift ledger + status-marked phases. v2 archived. |
| [`2026-04-23-clod-ui-test-strategy-v1.md`](./2026-04-23-clod-ui-test-strategy-v1.md) | Test pyramid + spine contract; ci:fast/deep/nightly tier definitions. |
| [`2026-06-10-clod-ui-completion-goal-v1.md`](./2026-06-10-clod-ui-completion-goal-v1.md) | The remaining arc as a /goal-ready queue: S1–S14, standing constraints, definition of done. Living; amend as slices land. |

## Active plans

| File | PR | Surface |
|---|---|---|
| [`2026-06-12-clod-ui-pr37-ci-nightly-v1.md`](./2026-06-12-clod-ui-pr37-ci-nightly-v1.md) | #37 | ci:nightly de-stubbing (goal S12): xhigh effort pinned by evidence + first contract tape + flake shuffle + guarded live smoke. |

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
| #19.1 | [`pr19-1-inspection-cleanup-v1`](./landed/2026-05-02-clod-ui-pr19-1-inspection-cleanup-v1.md) | Post-streaming-arc inspection: `useSubmitTurn` conv_id reset bug fix + plan rotation + INVARIANTS/README refresh. |
| #20a | [`pr20a-transcript-route-v1`](./landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md) | `parseTranscriptLine` + `readAllLines` + `GET /conversations/:id/transcript` route + `client.getTranscript()` + T1.15. |
| #20b | [`pr20b-transcript-history-v1`](./landed/2026-05-06-clod-ui-pr20b-transcript-history-v1.md) | `useTranscript` hook + `<TranscriptHistory />` + App composition + I-9 breadcrumbs (shared parser, identical wire shape). |
| #18d.1 | [`pr18d-1-scroll-to-bottom-v1`](./landed/2026-05-06-clod-ui-pr18d-1-scroll-to-bottom-v1.md) | `useStickyBottom` (late-ref attach via contentSignal) + scroll-agnostic TranscriptHistory/TurnView + single scroll container + ↓ Latest button in App. |
| #18d.2 | [`pr18d-2-markdown-renderer-v1`](./landed/2026-06-10-clod-ui-pr18d-2-markdown-renderer-v1.md) | `<Markdown>` (react-markdown + GFM, styled map, HTML stays escaped) in AssistantMessage + TextBlockView. |
| #18d.3 | [`pr18d-3-tool-card-collapsibles-v1`](./landed/2026-06-10-clod-ui-pr18d-3-tool-card-collapsibles-v1.md) | Collapsible ToolCard (turn-view) + ToolUseBlockView (history) — first layout-state hook in the web app. |
| #21 | [`pr21-launcher-v1`](./landed/2026-06-10-clod-ui-pr21-launcher-v1.md) | Launcher (Phase 7.3): engine static SPA serving (T1.16) + spawn/health-poll/browser-open/signal-ladder + 3 latent production-path fixes. |
| #22 | [`pr22-crash-recovery-v1`](./landed/2026-06-10-clod-ui-pr22-crash-recovery-v1.md) | Crash recovery (Phase 7.4): launcher restart-once on the pinned port (`CLOD_UI_ENGINE_PORT`) + web `<ConnectionBanner />` over the turn stream's own connection. |
| #23 | [`pr23-arch-v3-refresh-v1`](./landed/2026-06-10-clod-ui-pr23-arch-v3-refresh-v1.md) | Architecture v3: drift ledger (12 corrections), status-marked phases, v2 → archive. |
| #24 | [`pr24-turn-controls-v1`](./landed/2026-06-10-clod-ui-pr24-turn-controls-v1.md) | Phase 5.1/5.2: model picker + thinking effort — `thinking_effort` on the turn wire, `<TurnControlsBar />`, spine T1.17. |
| #25 | [`pr25-system-prompt-editor-v1`](./landed/2026-06-12-clod-ui-pr25-system-prompt-editor-v1.md) | Phase 5.3 (goal S1): collapsible `<SystemPromptEditor />` (append default, override warning) + malformed `system_prompt` → 400 + T1.17 extension. |
| #26 | [`pr26-dark-mode-v1`](./landed/2026-06-12-clod-ui-pr26-dark-mode-v1.md) | Phase 7.2 (goal S2): honest dark mode — `data-theme` switch, designed palette, `useTheme` + `<ThemeToggle />`, card-token fix. |
| #27 | [`pr27-keyboard-map-v1`](./landed/2026-06-12-clod-ui-pr27-keyboard-map-v1.md) | Phase 7.1 (goal S3): keyboard map — KEYMAP as data + `useKeymap` + `?` overlay + Composer `inputRef`. |
| #28 | [`pr28-raw-flags-v1`](./landed/2026-06-12-clod-ui-pr28-raw-flags-v1.md) | Phase 5.8 (goal S4): raw-flags escape hatch — per-turn `extra_argv` on the wire + `<RawFlagsEditor />` + T1.17 tail ordering. |
| #29 | [`pr29-tools-editor-v1`](./landed/2026-06-12-clod-ui-pr29-tools-editor-v1.md) | Phase 5.5 (goal S5): active tools editor — curated checkboxes + `Tool(pattern)` chips + T1.17 tools passthrough. |
| #30 | [`pr30-preferences-ui-v1`](./landed/2026-06-12-clod-ui-pr30-preferences-ui-v1.md) | Phase 5.4 (goal S6): preferences UI — `useSettings` (I-2) + `<SettingsPanel />` modal with diff-preview-gated PUT. |
| #31 | [`pr31-skills-discovery-v1`](./landed/2026-06-12-clod-ui-pr31-skills-discovery-v1.md) | Phase 5.6 (goal S7): skills discovery — `GET /skills` (I-1) + spine T1.18 + `<SkillsPanel />`; enablement descoped (no CLI mechanism). |
| #32 | [`pr32-diagnostics-v1`](./landed/2026-06-12-clod-ui-pr32-diagnostics-v1.md) | Phase 5.7 (goal S8): diagnostics — redacted per-turn ring + `GET /diagnostics` (T1.19) + Debug panel with Copy repro. |
| #33 | [`pr33-attachments-intake-v1`](./landed/2026-06-12-clod-ui-pr33-attachments-intake-v1.md) | Phase 6a part 1 (goal S9): attachments intake/serve + turn-body attachments + T1.20 + real-CLI smoke (base64 image source pinned). |
| #34 | [`pr34-attachments-ui-v1`](./landed/2026-06-12-clod-ui-pr34-attachments-ui-v1.md) | Phase 6a part 2 (closes goal S9): composer picker/drag-drop/chips + ChatMessage image block + history data-URI rendering. |
| #35 | [`pr35-orphan-sweeper-v1`](./landed/2026-06-12-clod-ui-pr35-orphan-sweeper-v1.md) | Phase 6b (goal S10): attachments orphan sweeper — pure planSweep + I-5 double-checked shell, dry-run default. |
| #36 | [`pr36-ci-deep-v1`](./landed/2026-06-12-clod-ui-pr36-ci-deep-v1.md) | ci:deep de-stubbed (goal S11): Playwright five-scenario spec over real engine + ChaosBackend; startEngineServer extraction. |
| #38 | [`pr38-tailnet-seat-v1`](./landed/2026-10-24-clod-ui-pr38-tailnet-seat-v1.md) | Same-origin guard (first Phase 8 seam), `CLOD_UI_CONVERSATION_CWD`, `CLOD_UI_CLAUDE_BINARY`; serves a project seat on the tailnet. |
| #39 | [`pr39-warm-sessions-v1`](./landed/2026-10-27-clod-ui-pr39-warm-sessions-v1.md) | One warm CLI process per conversation (SessionStart once, no per-turn boot); cache read/write in the usage badge; diagnostics `process`. |
| #40 | [`pr40-warm-hardening-v1`](./landed/2026-10-27-clod-ui-pr40-warm-hardening-v1.md) | Warm-session hardening: bounded awaitable retirement (EOF→TERM→KILL), one stdout pump with init gate, settle-before-yield, busy collision refused, `CLOD_UI_WARM_MAX`, stderr cap. |
| #41 | [`pr41-warm-lifecycle-edges-v1`](./landed/2026-10-27-clod-ui-pr41-warm-lifecycle-edges-v1.md) | Turn ownership token (a late `finally` can't retire the next turn's process); retirement done only when the whole process group is gone. |
| #42 | [`pr42-models-and-effort-v1`](./landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md) | The CLI's own model list (`GET /models` via the initialize control request) in the picker; effort = `/effort`'s levels (auto…max, ultracode), gated per model; spine T1.21. |
| #43 | [`pr43-warm-review-fixes-v1`](./2026-10-27-clod-ui-pr43-warm-review-fixes-v1.md) | Warm review fixes: handles stay tracked until their group sweep ends (stop() waits; self-exiting leaders swept); raw session flags (`--resume s2`, `--fork-session`, …) block reuse. |

## Conventions

- One plan per PR. Author the plan first, ship the impl, leave the plan in
  place. The plan is the source of truth for *why*; the code is the source
  of truth for *what*.
- Plans are immutable after their PR ships — corrections happen in the
  next plan ("PR #N revises the §X decision from PR #M because...").
- When `plans/` (active dir) approaches ~5 entries and PR #N has
  shipped, rotate `pr<N>-*-v1.md` into `landed/` and update this index.
