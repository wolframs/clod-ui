# Clod UI — Initial Architecture & Implementation Plan

> **SUPERSEDED.** Active plans are in `plans/`. Do not use this document for implementation decisions.

## Objective

Build a personal Claude chat UI ("Clod UI") that routes all model I/O through the **Claude Code CLI in headless mode**, so the user's existing Claude subscription is the source of tokens (compliant with Anthropic ToS for first-party software). The UI must feel like a polished modern chat client, expose key CLI knobs as first-class controls, support attachments and multi-turn session resume, and surface live process activity and errors.

## Guiding Principles

- **CLI is the engine, UI is the cockpit.** No direct Anthropic API calls. Every model interaction is a `claude` subprocess invocation using `--output-format stream-json` (and, for richer input, `--input-format stream-json`).
- **Sessions are first-class.** Each conversation maps to a Claude Code session ID; continuation uses `--resume <id>`. The on-disk JSONL transcripts in `~/.claude/projects/<encoded-cwd>/<id>.jsonl` are the source of truth for history.
- **Local-first, single-user.** No auth layer, no cloud sync in v1. State lives on disk.
- **Streaming everywhere.** UI reacts to NDJSON events live (text deltas, tool calls, tool results, thinking, errors, usage).
- **Strict separation** between (a) the process/orchestration layer that owns subprocesses and the filesystem, and (b) the presentation layer that renders state.

## Recommended Stack

- **Shell:** Tauri 2 (Rust) — owns subprocess lifecycle, filesystem, settings, event bus to webview.
- **Frontend:** Vite + React 18 + TypeScript + Tailwind CSS + shadcn/ui (or equivalent headless component kit) + TanStack Query + Zustand (or Jotai) for chat-stream state.
- **Markdown/code rendering:** `react-markdown` + `remark-gfm` + `shiki` (or `rehype-pretty-code`) for syntax highlighting; KaTeX optional.
- **Local persistence:** SQLite (via `tauri-plugin-sql` / `rusqlite`) for conversation index + UI metadata. Transcripts themselves stay in Claude Code's JSONL files (read-through).
- **Packaging target:** macOS first (the user's platform), with Linux/Windows considered "free" via Tauri.

## Initial Project Assessment

- **Workspace state:** Empty directory `clod-ui/` with only `initial-summoning.md` (the spec). Greenfield — no migration, no legacy.
- **External dependency:** A working Claude Code install (`claude --version`) authenticated against the user's subscription. Plan must detect and surface its absence gracefully.
- **Filesystem touchpoints (read/inspect, sometimes write):**
  - `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — canonical transcripts.
  - `~/.claude/settings.json` and `<project>/.claude/settings.json` — global + project prefs.
  - `~/.claude/skills/` and `<project>/.claude/skills/` — skill definitions.
  - A new app-owned dir (e.g. `~/Library/Application Support/clod-ui/`) for our SQLite DB, attachment scratch space, app config.

## Implementation Plan

### Phase 0 — Foundations

- [ ] Task 0.1. Scaffold a Tauri 2 + Vite + React + TS project inside `clod-ui/`. Configure pnpm (or bun) as package manager, ESLint + Prettier + TypeScript strict, Tailwind, and a base shadcn/ui setup. Rationale: locking the toolchain early avoids churn once features land.
- [ ] Task 0.2. Define the **event protocol** between Rust core and React UI as TypeScript interfaces generated from Rust types (e.g. via `ts-rs` or `specta`). This contract is the spine of everything below; defining it first prevents the two layers from drifting.
- [ ] Task 0.3. Add a startup health check: shell-out `claude --version` and `claude --help`, parse availability, surface a blocking onboarding screen with actionable install/login guidance if missing. Rationale: the entire app is useless without the CLI; failing fast and clearly is non-negotiable.

### Phase 1 — Headless CLI Orchestration Layer (Rust)

- [ ] Task 1.1. Implement a `ClaudeProcess` actor in Rust that spawns `claude -p --output-format stream-json --input-format stream-json [flags...]`, owns its stdin/stdout/stderr, and exposes a typed async API: `start(opts)`, `send_user_turn(payload)`, `cancel()`, plus a `tokio::sync::broadcast` of parsed events. Rationale: subprocess orchestration is the riskiest, most stateful part — isolating it in a single actor with clear boundaries keeps the rest of the app simple.
- [ ] Task 1.2. Define an `Event` enum that maps NDJSON event kinds emitted by Claude Code (`system.init`, `assistant` message deltas, `tool_use`, `tool_result`, `thinking`, `result`, `error`, `usage`, etc.) to strongly typed Rust structs; forward serialized variants to the webview via Tauri's event bus. Rationale: typed events let the UI render confidently and let us add new event kinds without breaking older ones.
- [ ] Task 1.3. Build a **flag composer** that takes a `TurnRequest` (model, thinking effort, system prompt mode, allowed/disallowed tools, MCP configs, permission mode, attachments, resume id, cwd) and produces the exact argv + stdin payload. Centralizing this avoids stringly-typed flag bugs scattered across the codebase.
- [ ] Task 1.4. Implement **graceful cancellation**: `cancel()` sends SIGINT, waits with timeout, then SIGTERM, then SIGKILL; UI gets a `cancelled` event. Rationale: long-running tool use must be interruptible without orphaning processes.
- [ ] Task 1.5. Implement **stderr capture + structured error surfacing** — parse known error patterns (auth failure, rate limit, missing tool permission, model unavailable) into typed `ErrorEvent`s; everything else becomes a generic `error` with raw text. Rationale: user-actionable errors > opaque tracebacks.

### Phase 2 — Session & Conversation Model

- [ ] Task 2.1. Design SQLite schema: `conversations(id, claude_session_id, title, model, created_at, updated_at, cwd, pinned, archived)`, `conversation_settings(conversation_id, system_prompt, append_system_prompt, thinking_effort, allowed_tools_json, disallowed_tools_json, skills_enabled_json, mcp_config_path)`, `attachments(id, conversation_id, turn_index, kind, original_name, stored_path, mime, size_bytes)`. Rationale: we need fast list/sort/search of conversations independent of reading every JSONL file.
- [ ] Task 2.2. Build a **transcript reader** that, given a `claude_session_id` + cwd, locates and tails the corresponding `~/.claude/projects/<encoded-cwd>/<id>.jsonl` and yields normalized `ChatMessage` items (user / assistant / tool blocks). Use file watching (`notify` crate) so the UI reflects out-of-band edits. Rationale: treating Claude Code's JSONL as canonical means we never desync from what `claude` itself sees on `--resume`.
- [ ] Task 2.3. Implement **new-conversation flow**: spawn the first turn without `--resume`, then capture the `session_id` from the initial `system.init` event and persist it. Rationale: we can't know the session id until the CLI emits it; the conversation row is upserted on first event.
- [ ] Task 2.4. Implement **resume flow**: subsequent turns reuse the saved `claude_session_id` via `--resume`; settings stored in `conversation_settings` are re-applied as flags every turn. Rationale: each `claude -p` invocation is stateless w.r.t. flags, so we must re-pass them; the conversation memory comes from `--resume`.
- [ ] Task 2.5. Implement **auto-title generation** by issuing a one-shot `claude -p` (no resume, no tools) after the first assistant turn with a tiny prompt asking for a 4–6 word title. Rationale: scannable sidebar UX without manual naming.

### Phase 3 — Core Chat UI

- [ ] Task 3.1. Build the responsive 3-pane layout: collapsible left sidebar (conversations), center transcript, optional right inspector (settings/activity). Use container queries so it gracefully degrades to a single pane on narrow widths. Rationale: meets the responsive-design requirement and matches user expectations from other chat clients.
- [ ] Task 3.2. Implement the **streaming message renderer**: assistant messages built incrementally from delta events; tool-use blocks rendered as collapsible cards with input/output; thinking blocks rendered as a separate, dimmed, collapsible "Reasoning" section; markdown + syntax highlighting; copy-code buttons. Rationale: the value of a custom UI over the bare CLI lies almost entirely in this rendering.
- [ ] Task 3.3. Implement the **composer**: multi-line textarea with `Shift+Enter` newline / `Enter` submit, slash-command stub (future), drag-and-drop and paste targets for attachments, attachment chip row, and an inline activity strip showing the current process state. Rationale: a great composer is the single biggest UX lever in a chat app.
- [ ] Task 3.4. Implement **process-activity indicator**: a persistent status pill in the composer reflecting `idle | starting | thinking | tool: <name> | streaming | cancelling | error`, derived from the event stream. Include a visible Cancel button while non-idle. Rationale: directly satisfies the "process activity should be visible" requirement.
- [ ] Task 3.5. Implement **error surfaces**: inline error bubble at the point of failure with retry, plus a non-blocking toast for ambient errors (e.g. CLI crashed). Rationale: errors must be visible without being modal.

### Phase 4 — First-class Controls (the spec's "pickers")

- [ ] Task 4.1. **Model picker** — fetch the available model list dynamically (preferred) or fall back to a curated static list keyed by Claude Code version; persisted per-conversation with a global default. Rationale: a hardcoded list rots; we should attempt discovery first.
- [ ] Task 4.2. **Thinking effort picker** — expose `off | think | think hard | think harder | ultrathink` as a segmented control. Map to a combination of prompt-suffix injection and `MAX_THINKING_TOKENS` env var on the spawned process. Document the mapping in a single source-of-truth module. Rationale: thinking control in Claude Code is partly prompt-driven and partly env-driven; encapsulating that complexity keeps the UI clean.
- [ ] Task 4.3. **System prompt block editor** — a per-conversation editable block with two modes: *append* (uses `--append-system-prompt`, recommended default — safer w.r.t. subscription policies) and *override* (uses `--system-prompt`, with a clear warning). Live character/token estimate. Rationale: the spec calls for editability; offering both modes covers the realistic use cases.
- [ ] Task 4.4. **Preferences UI** — a settings screen that reads/writes `~/.claude/settings.json` and project-level `.claude/settings.json` with schema-aware form controls (theme, default model, default thinking effort, default tool allowlist, telemetry toggles, etc.). Validate against a JSON Schema before write; keep a `.bak` of the previous file on every save. Rationale: editing JSON files from a UI must be safe — schema validation + backups prevent silent corruption.
- [ ] Task 4.5. **Active tools editor** — a checkbox/tag UI listing built-in tools (Read, Edit, Bash, WebFetch, etc.) and any MCP-provided tools, producing the `--allowedTools` / `--disallowedTools` arguments. Support fine-grained Bash patterns (e.g., `Bash(git:*)`). Per-conversation override of global default. Rationale: this is core to the spec and to safety.
- [ ] Task 4.6. **Skills loader** — list skills discovered in `~/.claude/skills/` and `<cwd>/.claude/skills/`, with toggles to enable/disable per conversation; persist enabled set and pass through whatever mechanism Claude Code expects (settings file mutation or CLI flag, depending on current Claude Code version — abstract behind a `SkillsBackend` trait so we can swap implementations). Rationale: the skill enablement surface in Claude Code is evolving; an abstraction lets us follow upstream changes without rewriting UI.

### Phase 5 — Attachments

- [ ] Task 5.1. Build an **attachment intake pipeline**: drag-drop, paste, and file-picker entry points → copy into a per-conversation scratch dir under app data → record in `attachments` table → render chips. Enforce per-file size limit and total-payload limit with clear UI feedback. Rationale: keeping attachments app-owned (not in user temp) means stable paths for resume/replay.
- [ ] Task 5.2. **Image handling** — embed images into the user turn using stream-json input with `image` content blocks (base64 or file references depending on what the installed Claude Code version supports; detect at startup). Rationale: images need first-class content blocks, not just file paths, for the model to actually see them.
- [ ] Task 5.3. **File handling** — for non-image files, attach by reference (absolute path mentioned in the user message + permitting `Read` tool for that path) so the assistant can pull what it needs without bloating context. Rationale: shoving full file bodies inline is wasteful and often wrong; tool-driven retrieval is the Claude Code-native pattern.
- [ ] Task 5.4. **Attachment cleanup** — on conversation delete, purge scratch files; offer a "Clean unused attachments" maintenance action. Rationale: prevents unbounded disk growth.

### Phase 6 — Polish & Resilience

- [ ] Task 6.1. **Keyboard map** — `Cmd+K` quick switcher, `Cmd+N` new conversation, `Cmd+/` focus composer, `Esc` cancel current turn, `Cmd+,` settings. Rationale: power-user feel costs little and pays often.
- [ ] Task 6.2. **Theme** — light/dark/system, with an honest dark mode (not just inverted). Persist in prefs.
- [ ] Task 6.3. **Crash recovery** — if a `ClaudeProcess` dies mid-stream, mark the in-flight turn as failed with a retryable error, ensure no zombie processes, and re-tail the JSONL on next render so any partial assistant content the CLI did flush is preserved. Rationale: subprocess fragility is real; visible recovery > silent loss.
- [ ] Task 6.4. **Diagnostics panel** — a hidden-by-default view showing the last N spawned commands (argv + redacted stdin), event log, and a "Copy repro" button. Rationale: when something weird happens, this is the difference between a bug report we can act on and one we can't.
- [ ] Task 6.5. **Logging** — structured logs to a rotating file under app data; UI toggle for verbosity. No PII or message bodies at default level.

## Verification Criteria

- A new conversation can be created, messages exchanged with streaming output, then the app fully closed and reopened, and the conversation resumed (new turns continue context correctly via `--resume`).
- Model picker, thinking-effort picker, system-prompt mode (append/override), allowed-tools selection, and skills toggles all measurably change `claude` invocation behavior, confirmed by the diagnostics panel showing the exact argv used.
- Attachments: at least one image and one non-image file can be attached and referenced by the assistant in its reply within a single conversation.
- Process activity pill transitions through `starting → thinking → tool:* → streaming → idle` for a turn that uses at least one tool, and the Cancel button reliably interrupts a long-running turn within ~2s.
- Errors from the CLI (e.g., revoked auth, unknown model, denied tool) appear as actionable inline messages, not raw stack traces.
- Layout remains usable at viewport widths from 360px (mobile-ish) up to 2560px (ultrawide), with sidebar collapsible.
- Editing prefs in UI produces valid `settings.json` files (schema-validated), with a `.bak` of the prior version, and is reflected on the next CLI invocation.
- No direct calls to `api.anthropic.com` from the app; the only outbound process is `claude` (verifiable by network inspection / source audit).

## Potential Risks and Mitigations

1. **Claude Code CLI surface changes between versions** (flags renamed, event-kind names tweaked, skills enablement mechanism evolves).
   Mitigation: encapsulate every CLI interaction behind a `ClaudeBackend` trait with a version-detected implementation; keep an integration test harness that spawns `claude -p` against a fixed prompt and snapshots the event stream shape; pin a minimum supported Claude Code version and surface an upgrade prompt below it.

2. **Subscription ToS edge cases around overriding the system prompt or running fully unattended.**
   Mitigation: default the system-prompt control to *append* mode; show a clear, dismissible warning on switching to *override*; never run multi-turn loops without a human-initiated turn (no autonomous agent loops in v1); document the policy stance in the app's About screen.

3. **Long-running tool calls leaving zombie subprocesses** if the app crashes.
   Mitigation: spawn `claude` in its own process group; on app start, scan for stranded child PIDs from a previous run (recorded in a pidfile) and reap them; rely on Tauri's app-exit hook to send SIGTERM cleanly.

4. **JSONL transcript files can be huge** for long conversations, hurting render performance.
   Mitigation: virtualized message list (e.g. `@tanstack/react-virtual`); incremental tail-reads (don't re-parse the whole file on each event); summarize/archive very old turns in the sidebar without dropping them on disk.

5. **Image attachment payloads can blow up token usage** silently.
   Mitigation: client-side downscale large images to a configurable max edge (e.g. 1568px); show estimated token cost per attachment chip before sending.

6. **Filesystem write to user-owned `settings.json` files** risks corrupting the user's broader Claude Code setup.
   Mitigation: schema validation + atomic writes (write to temp, fsync, rename) + `.bak` rotation; offer a one-click "Restore previous settings" from the UI.

7. **Concurrent turns / accidental double-sends** while a stream is active.
   Mitigation: composer is disabled (with clear visual state) while a turn is in flight; queueing is explicit (a "Send after current finishes" affordance), never implicit.

8. **Skills/MCP tool ecosystem is moving fast**; today's mechanism may not be tomorrow's.
   Mitigation: hide skills/MCP behind backends as noted; ship v1 with a "raw flags" escape hatch in advanced settings so power users aren't blocked when our abstractions lag upstream.

## Alternative Approaches

1. **Bun + Hono local server + Vite/React frontend over SSE.** Pros: 100% TypeScript, accessible from any device on the LAN, easier to hack on without Rust toolchain. Cons: ships/expects Bun runtime, weaker sandboxing of subprocess + filesystem access, more moving parts at install time. Good fit if multi-device access from a phone/tablet matters more than a single distributable binary.

2. **Electron + Node.** Pros: largest ecosystem, easiest subprocess + FS story in pure JS, lots of prior art for chat apps. Cons: heavy binary, RAM-hungry, slower startup, weaker security defaults than Tauri. Reasonable if Rust is a non-starter.

3. **Pure web app with a Claude Code "bridge" daemon.** Split the orchestration layer into a standalone local daemon (Rust or Bun) exposing a small WebSocket/HTTP API; the UI is a normal SPA hosted anywhere (even a static site) that connects to `localhost`. Pros: clean separation, lets you reskin the UI freely, headless-server-friendly. Cons: more setup friction for the user (two things to install/run), CORS and trust boundaries to think through. Worth keeping in mind as a v2 refactor target if you ever want to ship multiple UI frontends against one engine.

4. **TUI (Ratatui in Rust, or Ink in TS) instead of a webview.** Pros: ultra-light, lives in the terminal next to `claude` itself, very fast to build a v1. Cons: directly contradicts the "responsive design" and "attachments / images" requirements. Listed for completeness; not recommended given the spec.

## Open Assumptions (flag any you'd like to revisit)

- **Single user, local-only, no auth in v1.** No multi-tenant, no remote access.
- **macOS is the primary target** (Tauri builds for Linux/Windows are a freebie, not a focus).
- **Conversations are scoped to a working directory.** Each conversation has a `cwd`; tools that read/write files operate there. UI shows and lets the user pick the cwd at conversation creation, defaulting to a sensible per-app sandbox.
- **No telemetry, no analytics, no auto-update in v1.** Easy to add later; intentionally out of scope.
- **No conversation export in v1** (the JSONL files are already on disk if needed). Trivial to add later.
- **No multi-window in v1** — one main window, settings as an in-app route, not a separate window.
