# PR #39 — warm sessions: one CLI process per conversation, cache in plain view

_2026-10-27. The operator's ask: "fix shoddy caching, we want 100% maximum cache
efficiency". Not part of the S1–S14 queue; PR #37's uncommitted work in the
tree stays untouched._

## Evidence (habitat seat, CLI 2.1.310)

- Every turn spawned `claude -p … --resume <sid>` and closed stdin. The prompt
  cache itself already hit: turn 2 of a real session read 57 141 cached
  tokens = all of turn 1; requests carry 1h breakpoints. Nothing was busting
  the prefix.
- What each respawn cost instead: `SessionStart` fires with `source: resume`
  on every process, so the habitat's ~2.3k-token brief is appended to the
  conversation **every turn** (cache write at 2× input price, then re-read on
  every later turn: O(n²) over a conversation), plus ~3.6s of hook time and
  CLI boot before the model sees the message.
- Probe (scratch dir, haiku, test hooks): one process fed several stream-json
  user messages answers each with its own `system/init` + `result`, keeps the
  session id, fires `SessionStart` once and `UserPromptSubmit` per message.
  Warm and resume read the same cache when hook output is tiny; the
  difference is exactly the re-injected hook context.
- `UsageBadge` showed `input_tokens` only (2 on a 57k-token prompt): the
  cache was invisible in the UI.

## Decisions

1. **Warm process per conversation**, inside `RealClaudeBackend` (engine and
   wire unaware). After a `result`, stdin stays open and the process waits;
   the next turn of that conversation writes its message to the same stdin.
2. **Reuse rule** (pure, `warm-reuse.ts`): same cwd; same argv once
   `--resume <sid>` and `--add-dir` pairs are set aside; the request resumes
   exactly the warm process's session (no resume id → never reused, so
   persistence-less engines keep fresh-session semantics); the warm process's
   add-dirs ⊇ the turn's. Any control change (model, effort, prompt, tools,
   raw flags) therefore respawns with `--resume` — one cold turn, like today.
3. **Retire** (end stdin, SIGTERM after 2s) on: idle timeout, an error
   result, a process that exited, a non-reusable next turn, `stop()`.
   Cancel keeps the existing ladder; the killed process is dropped, the next
   turn cold-starts.
4. **Opt-in at the class, on in production**: `warmIdleMs` defaults to 0
   (old one-shot path, all shim tests unchanged). The engine entrypoint reads
   `CLOD_UI_WARM_IDLE_MS`, default 3 600 000 (the 1h cache TTL); `0` turns it
   off.
5. **Diagnostics tell the truth**: optional `ClaudeBackend.reusableArgv(req)`;
   the ring records the warm process's argv and `process: 'reused'`, else the
   composed argv and `'spawned'`. New optional `process` field on
   `TurnDiagnostics`; the panel shows it.
6. **Cache in the badge**: `turn.result.usage` gains
   `cache_read_input_tokens` / `cache_creation_input_tokens` (parser → wire →
   reducer); `UsageBadge` shows read / write next to ↑ ↓.

## Not done

- `TODO(warm-interrupt)`: cancel via the stream-json `interrupt` control
  request, keeping the process warm. Kill-and-respawn is simpler and costs
  one resume.
- The habitat's hook could also skip its brief on `source: resume`; that is
  the habitat's repo, not this one.

## Tests

- `warm-reuse.test.ts`: the rule as a table.
- `real.test.ts`: a stdin-line-driven shim — two turns, one pid; control
  change respawns; error result retires; idle timeout retires; warm off keeps
  one process per turn.
- parser: cache fields extracted; `UsageBadge` renders them.
