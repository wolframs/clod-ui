# Spine catalog

The 49 tests across 20 contract files in [`tests/spine/`](../tests/spine/).
Each contract is a _behavior_ the engine must preserve across PR
churn — the spine gates every commit through `bun run ci:fast`.

This file is the canonical mapping of T-id → file → contract → tests.
When session summaries disagree with this file, **trust this file**.
Drifted summaries have been observed historically; on-disk filenames
and headers are authoritative.

---

## Contracts

| T-id  | File                                                                                                                      | Contract (1-line)                                                                                                                                                                                                                                                                            | Tests | PR un-skipped          |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ---------------------- |
| T1.01 | [`T1.01-new-conversation-captures-session-id.test.ts`](../tests/spine/T1.01-new-conversation-captures-session-id.test.ts) | `system.init.session_id` flows through engine _and_ persists in both SQLite + `manifest.json`.                                                                                                                                                                                               |     2 | #4 (obs), #6 (persist) |
| T1.02 | [`T1.02-resume-passes-flags.test.ts`](../tests/spine/T1.02-resume-passes-flags.test.ts)                                   | Second turn's argv contains `--resume <session_id>` plus every per-conv setting (model, tool allowlist, system-prompt).                                                                                                                                                                      |     1 | #3                     |
| T1.03 | [`T1.03-resume-after-restart.test.ts`](../tests/spine/T1.03-resume-after-restart.test.ts)                                 | After engine teardown + reopen against the same app-data dir, the next turn auto-injects the captured `claude_session_id` as `resume_session_id`. Manifest survives across restarts (no truncation, monotonic seq, intact hash chain).                                                       |     1 | #6                     |
| T1.04 | [`T1.04-streaming-ordering.test.ts`](../tests/spine/T1.04-streaming-ordering.test.ts)                                     | For every turn: `turn.result` is the last envelope; every `tool.use` is paired with one `tool.result` / `tool.error`; `assistant.delta` chunks arrive in the order the backend produced them. Property-style with PRNG-seeded random scripts.                                                |     1 | #4                     |
| T1.05 | [`T1.05-cancel-ladder.test.ts`](../tests/spine/T1.05-cancel-ladder.test.ts)                                               | `cancel()` sends SIGINT; after `grace1` escalates to SIGTERM; after `grace2` escalates to SIGKILL. Engine emits `turn.cancelled` tagged with the escalation level reached. No zombies.                                                                                                       |     1 | #5                     |
| T1.06 | [`T1.06-cancel-before-first-event.test.ts`](../tests/spine/T1.06-cancel-before-first-event.test.ts)                       | Cancelling a turn that has not yet emitted any event produces a clean shutdown with a single terminal `turn.cancelled` envelope.                                                                                                                                                             |     1 | #5                     |
| T1.07 | [`T1.07-crash-mid-stream.test.ts`](../tests/spine/T1.07-crash-mid-stream.test.ts)                                         | Backend throws after the 3rd event; engine routes through `classifyCliFailure` and broadcasts `turn.error{kind: 'cli_crashed', retryable: true}`. Exactly the first 3 events + 1 turn.error are broadcast; no zombies.                                                                       |     1 | #5                     |
| T1.08 | [`T1.08-concurrent-send-rejected.test.ts`](../tests/spine/T1.08-concurrent-send-rejected.test.ts)                         | While a turn is in flight, a second `POST` on the same conversation returns HTTP 409 with `{ error: { kind: 'conversation_busy', active_turn_id } }`.                                                                                                                                        |     1 | #5                     |
| T1.09 | [`T1.09-settings-roundtrip.test.ts`](../tests/spine/T1.09-settings-roundtrip.test.ts)                                     | A `ClaudeSettings` object written via the engine's settings endpoint and re-read returns identical documented keys (`theme`, `model`, `allowedTools`, `disallowedTools`) and preserves any unknown keys byte-for-byte in the `unknown` passthrough bucket without corruption or reordering.  |     2 | #8                     |
| T1.10 | [`T1.10-manifest-fold-and-append-only.test.ts`](../tests/spine/T1.10-manifest-fold-and-append-only.test.ts)               | Manifest is an append-only log of `ManifestEvent`s. Fold is deterministic; writes never rewrite earlier entries; truncation yields a typed `ManifestCorruptError`; in-place tampering of an earlier event is detected by hash-chain.                                                         |     4 | #6                     |
| T1.11 | [`T1.11-transcript-watcher.test.ts`](../tests/spine/T1.11-transcript-watcher.test.ts)                                     | Engine watches `<CLAUDE_HOME>/projects/<encoded-cwd>/<session_id>.jsonl` and emits `transcript.updated` envelopes for new lines. Picks up files materialized after `system.init`; coalesces rapid bursts into a single batch.                                                                |     3 | #7                     |
| T1.12 | [`T1.12-health-and-readiness.test.ts`](../tests/spine/T1.12-health-and-readiness.test.ts)                                 | `GET /health` returns `HealthResponse` whose `cli` field reflects the CC CLI's real state — `ok` (binary on PATH + `--version` parses), `missing` (no binary). `unauthenticated` is **not** surfaced at health (auth is checked at first turn).                                              |     2 | #2                     |
| T1.13 | [`T1.13-conversations-list.test.ts`](../tests/spine/T1.13-conversations-list.test.ts)                                     | `GET /conversations` returns the sidebar projection — `ConversationSummary` entries fusing SQLite `conversations` table with the manifest fold's `state.title` and `max(events.ts)`. Reflects a completed turn (title + session_id + timestamps populated). Sorted by `updated_at` desc.     |     2 | #12                    |
| T1.14 | [`T1.14-reconnect-and-resume.test.ts`](../tests/spine/T1.14-reconnect-and-resume.test.ts)                                 | A subscriber that disconnects can reconnect with `?since=<lastEventId>` and receive only the envelopes that arrived during the gap (when within buffer capacity). `?since=<latest>` returns no replay — the buffer respects the cursor and never re-delivers already-seen envelopes.         |     2 | #17                    |
| T1.15 | [`T1.15-transcript-route.test.ts`](../tests/spine/T1.15-transcript-route.test.ts)                                         | `GET /conversations/:id/transcript` returns the full JSONL projection (`TranscriptResponse`). Reflects file-system reality: missing/empty file → `lines: []`; populated file → in-order lines with monotonic `line_number` + `byte_offset`. Wraps the `@clod-ui/transcripts` `readAllLines`. |     2 | #20a                   |

| T1.16 | [`T1.16-static-assets.test.ts`](../tests/spine/T1.16-static-assets.test.ts) | Opt-in `static: { dir }` serves the built SPA from the engine origin: `/` → index.html, exact assets served, unknown paths → SPA fallback, API routes win, resolution never escapes the root, unconfigured engines keep their 404. | 4 | #21 |
| T1.17 | [`T1.17-turn-controls-passthrough.test.ts`](../tests/spine/T1.17-turn-controls-passthrough.test.ts) | `model` + `thinking_effort` + `system_prompt` + `extra_argv` in the `POST /turns` body reach the backend's `TurnRequest` unmodified and `compose()` to `--model` / `--effort` / `--append-system-prompt`-or-`--system-prompt` argv pairs plus a verbatim `extra_argv` tail after every composed flag; absent controls compose no flags; an unrecognized `thinking_effort`, malformed `system_prompt`, or malformed `extra_argv` is a 400 and never reaches the backend; `allowed_tools` / `disallowed_tools` compose to `--allowedTools` / `--disallowedTools`. | 9 | #24, #25, #28, #29 |

| T1.18 | [`T1.18-skills-discovery.test.ts`](../tests/spine/T1.18-skills-discovery.test.ts) | `GET /skills` (opt-in) lists SKILL.md-bearing directories from the configured user + project roots with frontmatter descriptions, sorted user-first then by name; missing roots → `{ skills: [] }`; unconfigured → exact I-1 `404 { error: 'skills not configured' }`. Display-only (no per-skill CLI argv exists — `TODO(skills-enablement)`). | 3 | #31 |

| T1.19 | [`T1.19-diagnostics-ring.test.ts`](../tests/spine/T1.19-diagnostics-ring.test.ts) | With diagnostics enabled, every accepted turn records redacted argv (system-prompt text never observable), env key names, stdin byte size, ordered event timeline, terminal outcome; `GET /diagnostics` lists most-recent-first within capacity; unconfigured → exact I-1 `404 { error: 'diagnostics not configured' }`. Wire-only (I-8). | 3 | #32 |

| T1.20 | [`T1.20-attachments-intake.test.ts`](../tests/spine/T1.20-attachments-intake.test.ts) | `POST /conversations/:id/attachments` (JSON+base64, persistence-gated) writes sanitized, collision-suffixed files into the conversation's `attachments/` and returns typed metadata; turn-body `attachments` reach the backend and `compose()` emits the image stdin block + `--add-dir`; malformed body attachments → 400; serving never escapes the dir; unconfigured → exact I-1 404. | 4 | #33 |

**Total: 49 / 49 tests live across 20 contract files. 0 reserved.**

---

## Conventions

- **One file per contract.** A "contract" is a behavior the engine
  must preserve indefinitely. New contracts get a new `T1.NN` file;
  existing contracts get more tests inside their existing file.
- **In-process by default.** Spine tests boot `createApp({ ... })`
  with a `ScriptedBackend` (or `TapeBackend` for cross-checks) and
  drive turns via `TypedTestClient` over a real `Bun.serve`. No
  subprocess engines, no shell spawns of `claude`.
- **Hermetic.** Every test mints its own `mkdtempSync` root; SQLite
  - manifest live under there; cleanup in `afterEach`.
- **No skips.** A spine test that can't pass yet stays out of `tests/spine/`
  — it lives in the active PR's plan as "deferred", and lands as a
  full file when its un-skipping PR ships.

---

## Adding a new contract

1. Pick the next `T1.NN` number (highest existing + 1).
2. Author a top-of-file docstring stating the contract in plain
   English. Reference the un-skipping PR's plan path.
3. Write the test(s) using the same boot pattern as a sibling file
   in the same surface area (e.g. T1.13 for HTTP routes, T1.11 for
   WS-driven flows, T1.10 for pure store invariants).
4. Add a row to the table above.
5. Update `README.md` if the spine count claim changed.
