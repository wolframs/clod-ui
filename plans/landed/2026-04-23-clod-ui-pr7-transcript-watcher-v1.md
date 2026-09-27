# PR #7 — Transcript watcher (T1.11)

> Status: Active. This plan executes architecture v2 Task **3.4** (transcript reader) in a single reviewable slice. Companion plans: `plans/2026-04-23-clod-ui-architecture-v2.md`, `plans/2026-04-23-clod-ui-test-strategy-v1.md`. Predecessor: `plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md` (persistence is the soil this PR plants in).

## Objective

Stand up a per-conversation transcript watcher so the engine emits `transcript.updated` envelopes whenever Claude Code appends a JSONL line to its session file under `<CLAUDE_HOME>/projects/<encoded-cwd>/<session-id>.jsonl`. The watcher:

1. Tolerates the file appearing **after** the watcher starts (the CC subprocess writes the JSONL on its own clock, after `system.init`).
2. Never double-emits a line, even across mid-flight watcher restarts that re-scan the file.
3. Coalesces rapid bursts of writes into batched `transcript.updated` events via a debounce window.
4. Surfaces parse failures as warnings on the line, not as crashes — one bad line never poisons the watcher.

Un-skips **T1.11** (3 concrete tests). Spine count moves from **20 / 12 contracts (T1.11 + T1.09 reserved)** to **23 / 12 contracts (T1.09 reserved)**. The `tests/spine` directory becomes one contract away from full executable coverage.

## Out of Scope

- **`@clod-ui/settings` real impl** — PR #8 (T1.09).
- **Auto-titling** — Phase 3.5; needs the watcher's first-assistant-line signal but is its own slice.
- **`ChatMessage` normalization** — the watcher emits the *raw decoded JSON* of each new line in this PR. Higher-level normalization (turning CC's transcript shape into a UI-friendly `ChatMessage`) is downstream UI work, not engine spine.
- **Transcript replay buffer for late subscribers** — the WS replay buffer is Phase 2 Task 2.8 proper; until then, late WS clients re-fetch via HTTP (also future).
- **Transcript file rotation / rename handling beyond detect-and-restart** — CC does not currently rotate JSONL within a session; if upstream behavior changes we cross that bridge then. We do handle file disappearance + recreation by re-tailing from byte 0 with line-number deduplication on the in-memory cursor.
- **chokidar dependency** — we use Node's `fs.watch` with a polling fallback (`fs.watchFile`) on Linux for the unit-tested branch; production uses a small polling interval (50ms default) for predictable, hermetic behavior. Adding chokidar would be the right call only if `fs.watch` proves flaky across platforms.

## Design

### Manifest taxonomy decision: no new manifest event kinds

The previous agent noted "exact taxonomy is the first design question." After tracing the architecture invariant ("Sessions are first-class; transcripts are the CLI's. … we read-through it, we do not duplicate it." — `plans/2026-04-23-clod-ui-architecture-v2.md:15`), the right answer is:

**`transcript.updated` is a wire event only; the manifest gains no new kinds in this PR.**

Rationale:

- The JSONL file under `<CLAUDE_HOME>/projects/.../<session>.jsonl` is the canonical transcript. Mirroring its content into `manifest.json` would violate the "do not duplicate" invariant and double our disk traffic.
- The watcher's "what byte offset have we emitted up to?" is in-process state. On engine restart we re-tail from byte 0 and re-emit; the WS replay-buffer + UI cursor handle deduplication on the client side. Adding a `transcript.observed` checkpoint event would be premature — we have no consumer for it yet.
- This keeps the manifest's job sharp: **state-shaping events** (created, settings, attachments). Read-through observations stay out.

If a future PR needs a checkpoint (e.g., a "resume transcript from line N" affordance to avoid re-emitting on a known-good UI), it adds `transcript.checkpoint { last_line_number, byte_offset }` then. Not now.

### New wire event kind: `transcript.updated`

Defined in the new `@clod-ui/transcripts` package (not in `@clod-ui/backend`, because backends do not emit it — the watcher is an engine subsystem peer to the backend):

```ts
export interface TranscriptLine {
  /** zero-indexed line number within the JSONL file */
  line_number: number;
  /** byte offset of the start of this line within the file */
  byte_offset: number;
  /** decoded JSON object, or null if the line failed to parse */
  raw: unknown;
  /** present iff JSON.parse threw */
  parse_error?: { message: string; raw_text: string };
}

export interface TranscriptUpdatedEvent {
  kind: 'transcript.updated';
  conv_id: string;
  session_id: string;
  /** lines newly observed since the last emit; never empty */
  lines: TranscriptLine[];
}
```

The engine's `wrap()` helper widens its parameter type from `BackendEvent` to `BackendEvent | TranscriptUpdatedEvent`. The wire envelope's `kind` is set to `'transcript.updated'`; the `payload` is the event object as-is.

The contracts package does not yet have a Zod schema for transcript events (contracts in this repo are added per-feature, not speculatively). The TypedTestClient consumes envelopes by `kind` string, so spine tests work without a schema. A schema lands when the web UI starts consuming this kind in PR #N+M.

### `encodeCwd(cwd)` — Claude Code's directory convention

Claude Code writes to `<CLAUDE_HOME>/projects/<encoded-cwd>/<session-id>.jsonl`, where `encoded-cwd` is the absolute path with `/` replaced by `-`. For `/Users/example/Projects/clod-ui` the directory is `-Users-example-Projects-clod-ui`. Edge cases:

- A path with a leading slash starts the encoded dir with a leading `-` (so `/Users/...` → `-Users-...`). We preserve that — matching CC.
- We do **not** percent-encode anything else (CC doesn't either, and tests assert the raw mapping).
- `encodeCwd('/')` → `-` (degenerate but defined). We do not special-case it; the test asserts the deterministic mapping.

A future PR may need to handle CC's actual encoding edge cases (spaces, unicode, dots) once we observe a real tape diverge. We keep the implementation a pure function with a table-driven test so changing it later is one-file work.

### `TranscriptWatcher`

```ts
export class TranscriptWatcher {
  constructor(opts: TranscriptWatcherOptions);
  /** Begin watching. Idempotent: a second start is a no-op. */
  start(): void;
  /** Stop watching, flush any pending debounced batch, release fs handles. */
  stop(): Promise<void>;
  /**
   * Force a synchronous tail-pass right now, bypassing the poll interval.
   * Used by tests and by the engine's "we just observed system.init, the file
   * may already be there" code path. Returns the number of new lines emitted.
   */
  tickNow(): Promise<number>;
}

export interface TranscriptWatcherOptions {
  conv_id: string;
  session_id: string;
  /** Conversation cwd; encodes into the projects-dir subpath. */
  cwd: string;
  /** Root of `<CLAUDE_HOME>/projects`. Engine derives from CC env. */
  projectsDir: string;
  /** Receives one `transcript.updated` event per debounced batch. */
  onUpdate: (event: TranscriptUpdatedEvent) => void;
  /** Polling interval (ms). Default 50. */
  pollIntervalMs?: number;
  /** Debounce window (ms). Default 25. */
  debounceMs?: number;
  /** Time source — defaults to global setTimeout/clearTimeout/Date.now. */
  timers?: TimerLike;
}

export interface TimerLike {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
}
```

**State machine** (single conversation):

- `idle` (constructed, not started) → `start()` → `awaiting-file`
- `awaiting-file`: poll the directory at `pollIntervalMs`. If the file exists, transition to `tailing`.
- `tailing`: poll the file at `pollIntervalMs`. On size growth, read new bytes, split on `\n`, append to a pending-batch. Each batch arrival kicks the debounce timer.
- Debounce fires → call `onUpdate(...)` with all pending lines, clear the buffer.
- `stop()` → flush any pending batch synchronously via `onUpdate`, clear timers, release file handle, transition to `stopped`.

**Cursor**: `byte_offset` (next byte to read) + `line_number` (next zero-indexed line to emit). On disappearance + reappearance the cursor resets to 0 and lines re-emit from the top — this is fine because the consumer (UI) dedupes on `(session_id, line_number)` pairs in its replay-buffer logic.

**Polling, not `fs.watch`**: predictable across macOS/Linux, no inotify quirks, trivially testable with a `FakeClock`-shaped `TimerLike`. The cost is O(stat+read) per poll; for a 50ms interval that's ~20 stat-calls/sec, negligible. We can swap in `chokidar` if a perf budget ever bites.

**Parse errors**: a line that fails `JSON.parse` is emitted with `raw: null` and `parse_error: { message, raw_text }`. The watcher continues. T1.11's "no double-emit" test does not need to assert this, but the unit tests do.

### Engine wiring

`createApp({backend, store?, db?})` keeps its existing shape. New optional field:

```ts
interface CreateAppOptions {
  // ...existing fields...
  /**
   * Roots used by the transcript watcher. When omitted, no watcher is started
   * (matches the legacy memory-only contract). When provided, every captured
   * `system.init` starts a `TranscriptWatcher` for that conversation.
   */
  transcripts?: {
    /** `<CLAUDE_HOME>/projects` directory. */
    projectsDir: string;
  };
}
```

Lifecycle inside the engine:

1. On the persistence intercept that handles `system.init`, after `recordSessionId` succeeds, the engine looks up the conversation's cwd from the row and starts a `TranscriptWatcher` keyed by `(conv_id, session_id)`. Idempotent: a second `system.init` for the same conversation is a no-op (the existing watcher continues; we never start a duplicate).
2. The watcher's `onUpdate` calls `broadcast(wrap(envelopeIds.next(), event, conv_id))`.
3. `cancelAll()` (already used for shutdown) also stops every active watcher.
4. The production `import.meta.main` entrypoint resolves `projectsDir` from `CLAUDE_HOME ?? <home>/.claude` joined with `projects/`. Tests inject an explicit `transcripts.projectsDir` rooted at `TestEnv.fakeClaudeHome`.

Watcher registry: a `Map<conv_id, TranscriptWatcher>` on the `AppContext`. Disposal is part of `cancelAll`.

### Resume-after-restart behavior

On engine #2 boot, the conversation's row already has a `claude_session_id`. Engine #2 does **not** start a watcher proactively — the trigger is still `system.init`. When engine #2's first turn fires and the backend re-emits `system.init` with the same session_id, the watcher starts and re-tails from byte 0. The UI sees the full transcript again; its dedup cursor decides what to render. This matches the architecture's "the JSONL is the model's view of history" principle.

If we later want eager-on-boot watchers (no waiting for `system.init`), it's a one-liner in the `import.meta.main` block: iterate rows with non-null `claude_session_id`, start a watcher each. We defer that; it's not required to satisfy T1.11.

## Tasks

### §1 — `@clod-ui/transcripts` package
- New workspace package with `package.json`, `tsconfig.json`, `src/`, `tests/`.
- `src/encode-cwd.ts`: pure `encodeCwd(cwd: string): string`.
- `src/types.ts`: `TranscriptLine`, `TranscriptUpdatedEvent`, `TranscriptWatcherOptions`, `TimerLike`.
- `src/watcher.ts`: `TranscriptWatcher` class. Uses `node:fs/promises` for read, `node:fs` for stat, manual polling.
- `src/index.ts`: export the public API.
- `tsconfig.base.json` + root `tsconfig.json`: add `@clod-ui/transcripts` path mappings.

### §2 — Unit tests in `packages/transcripts/tests/`
- `encode-cwd.test.ts`: table-driven (`/Users/x` → `-Users-x`, `/` → `-`, `/a/b/c` → `-a-b-c`).
- `watcher.test.ts`:
  - **appends without duplicates**: write 3 lines, `tickNow()`, expect one batch with 3 lines; write 2 more, `tickNow()`, expect one batch with 2 lines (line_numbers 3, 4).
  - **picks up files that appear after start**: start watcher on empty dir, `tickNow()` → no events; create file with 1 line, `tickNow()` → batch with line_number 0.
  - **debounces rapid writes into one batch**: with an injected `TimerLike` whose timers we drive manually, append three lines across three poll cycles, advance through the debounce window, expect *one* `onUpdate` call with all three lines (or, if delivered eagerly per-poll, expect each batch to be coalesced by the debounce — see implementation note in the test).
  - **parse error tolerance**: append a bad line followed by a good line, `tickNow()`, expect both emitted, the bad one with `parse_error` set.
  - **stop is idempotent**: call `stop()` twice, no throw.

### §3 — Engine integration
- Extend `CreateAppOptions` with `transcripts?: { projectsDir: string }`.
- Maintain `Map<conv_id, TranscriptWatcher>` on the app context.
- On `system.init` intercept (post-`recordSessionId`), start a watcher if `transcripts` is present and no watcher exists for this conv_id.
- Watcher's `onUpdate` broadcasts an envelope with `kind: 'transcript.updated'`.
- Extend `cancelAll()` to also stop every watcher.
- Production entrypoint: resolve `projectsDir` from `process.env.CLAUDE_HOME ?? '<home>/.claude'` + `'projects'`.

### §4 — Spine T1.11 un-skip
- Replace `describe.skip` with three concrete tests against an in-process engine.
- Pattern: `TestEnv` for `appDataDir` + `fakeClaudeHome`. ScriptedBackend emits `system.init` then a `result`. After the `system.init` is observed via WS, the test writes synthetic JSONL lines into `<fakeClaudeHome>/projects/<encoded-cwd>/<session>.jsonl` and asserts a `transcript.updated` envelope arrives over the WS within the timeout, with the right `line_number`s and decoded content.
- Three tests:
  - **emits updates for appended lines without duplicates** — write 2 lines, await one envelope; write 2 more, await a second envelope; assert no third envelope and exact `line_number`s.
  - **picks up files that appear after watcher start** — `system.init` fires before the JSONL exists; the test creates the file *after* and asserts the watcher detects it.
  - **debounces rapid writes into batched events** — write 5 lines back-to-back; assert at most 2 envelopes (typically 1) with all 5 lines covered exactly once.

### §5 — Verify
- `bun run ci:fast` green.
- 10× flake check on `tests/spine/T1.11-*` and `packages/transcripts/tests/*`.
- `expectNoZombies()` (no subprocess in this PR, but the watcher releases its timers cleanly — assertion: `cancelAll()` returns before tests dispose).
- Commit in 3–4 logical chunks: package surface; package impl + unit tests; engine wiring; spine un-skip.

## Risk + Mitigation

1. **`fs.watch` flakiness on macOS/Linux** — sidestepped by using polling + a stat loop. Cost is at most ~20 syscalls/sec per active conversation, dwarfed by everything else.
2. **Race between `system.init` arrival and CC actually creating the file.** Watcher starts in `awaiting-file` and polls until the file appears, so this is exactly the design. The spine "appears-after-start" test pins this behavior.
3. **Test flake from real-time polling vs. `awaitEvent` timeouts.** Mitigated by giving the test a generous timeout (2000ms) and a small `pollIntervalMs` (10ms) inside the spine test. Unit tests use injected `TimerLike` for deterministic control.
4. **Unbounded line buffering on a runaway CC subprocess.** The debounce window caps batch size only by time, not by count; in practice CC does not emit pathologically. If it ever does, we add `maxBatchLines` later. Out of scope for spine.
5. **Encoded-cwd mismatch with real CC.** A nightly tape (Phase T1 contract) would catch drift; for now the unit test pins our mapping and the spine test uses a path that exercises the same encoder on both writer (test) and reader (watcher).

## Open items (forward)

- Eager-on-boot watcher start for known sessions (no `system.init` wait) — one-liner, deferred until a feature needs it.
- Schema-validated `TranscriptLine.raw` mapping into `ChatMessage` — Phase 4.4 work.
- WS replay buffer that retains the last N `transcript.updated` envelopes per conversation — Phase 2 Task 2.8 proper.
- Transcript checkpoint manifest event (`transcript.checkpoint { last_line_number }`) — only when a "skip first N lines on resume" feature lands.
- Cross-restart watcher resumption — the current "re-tail from 0 and let UI dedupe" design is acceptable; revisit if UI-side dedup proves expensive.

## What unblocks next

Spine reaches **23 tests across 12 contracts (T1.09 reserved, all others live)** by end of this PR — the closest the project has been to "every essential behavior is covered by an executing test." The remaining contract is **T1.09 (settings round-trip)** in PR #8. After that, Phase 2 closes and Phase 3 polish begins (auto-titling, ChatMessage normalization, web UI scaffolding).
