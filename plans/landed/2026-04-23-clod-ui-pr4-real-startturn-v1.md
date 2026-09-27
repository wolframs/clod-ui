# Clod UI — PR #4 Scope: Real startTurn + Engine Routes + T1.01 Observability (v1)

> **Status:** Active. Third slice of Phase 2. Depends on PR #3 (merged / staged).
>
> **Reads required:**
> - `plans/2026-04-23-clod-ui-architecture-v2.md` §Phase 2 Task 2.1 (engine bind), 2.3 (RealClaudeBackend), 2.7 (Hono routes), 2.8 (WS)
> - `plans/2026-04-23-clod-ui-test-strategy-v1.md` T1.01, T1.04
> - `plans/landed/2026-04-23-clod-ui-pr3-flag-composer-v1.md` (for scope-slicing precedent)

## Ground Truth: Real Stream-JSON Output

A single probe `echo '<user-msg>' | claude -p --input-format stream-json --output-format stream-json --verbose` against the installed CLI (v2.1.118) produces NDJSON lines of these shapes (abridged):

- `{"type":"system","subtype":"hook_started",...}` — SessionStart hook noise; **ignore**
- `{"type":"system","subtype":"hook_response",...}` — ditto; **ignore**
- `{"type":"system","subtype":"init","session_id":"<uuid>","cwd":"...","tools":[...]}` → `BackendEvent { kind: 'system.init', session_id }`
- `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}` → one `assistant.delta{text}` per text block
- `{"type":"assistant","message":{"content":[{"type":"tool_use","id","name","input"}]}}` → `tool.use{tool_use_id,name,input}`
- `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content","is_error"?:boolean}]}}` → `tool.result{tool_use_id,content}` or `tool.error{tool_use_id,message}` when `is_error: true`
- `{"type":"rate_limit_event",...}` — **ignore**
- `{"type":"result","subtype":"success","session_id","usage":{...},"total_cost_usd":...}` → `turn.result { usage? }`
- `{"type":"result","subtype":"error_during_execution"|...,"is_error":true,...}` → `turn.error { error: {kind:'cli_crashed', ...} }` (finer mapping → PR #5)

Every line carries `session_id`; the parser latches the first one it sees from the `system.subtype=init` event as the authoritative session id.

## Scope Note (why this is still a slice, not the whole engine)

This PR lands the smallest useful cut that makes T1.01's observability half pass against an in-process `createApp(backend)`. Deliberately deferred:

- **Full cancel ladder** (SIGINT → SIGTERM → SIGKILL escalation, `turn.cancelled` with escalation level) → PR #5 (T1.05, T1.06).
- **Error taxonomy stderr sniffers** (`auth_failed`, `rate_limited`, `tool_denied`, etc.) → PR #5 (T1.07, T1.08 + T2.12 fixtures).
- **SQLite + manifest persistence half of T1.01** → PR #6 (T1.01 complete, T1.03, T1.10).
- **Pidfile + single-instance lock + zombie sweep on startup** → PR #5.
- **`--include-partial-messages` true streaming** — the composer does not yet pass this flag; each assistant text content block arrives as a single `assistant.delta`. Flipping this on is a one-line composer change + a parser extension in a later PR once we've measured the perf impact.

## Objective

1. Implement `parseStreamJsonLine` — pure, `(line: string) => BackendEventInput | null`, unit-tested against every recognized shape.
2. Implement `RealClaudeBackend.startTurn(req)` and a minimal `cancel(turnId)` (SIGTERM-only). Spawn via `Bun.spawn` with `detached: true` so every turn has its own pgid; pipe `compose(req).stdin` into the child, read stdout line-by-line, yield parsed events with `turn_id` attached. Emit `turn.error{cli_crashed}` if the subprocess exits non-zero without first having emitted a `result` line. Verified against synthetic bash shims — no real CLI dependency in tests.
3. Extend `apps/engine/src/index.ts`'s `createApp(backend)` factory to accept a full `ClaudeBackend` and mirror `MockEngineServer`'s three wire routes: `POST /conversations/:id/turns`, `POST /conversations/:id/cancel`, `GET /ws`. Envelopes wrap `BackendEvent`s identically to `MockEngineServer` so `TypedTestClient` works unchanged.
4. Un-skip the **observability half** of T1.01: submit a turn, observe `system.init.session_id` over WS, assert it equals the backend's announced id. The SQLite/manifest persistence half stays in a nested `describe.skip` with a `FIXME(pr-6)`.
5. `bun run ci:fast` green, 10× with zero flakes, no process leaks.

## Implementation Plan

### Section 1 — Stream-JSON parser (`packages/backend/src/parse-stream-json.ts`)

- [ ] Task 1.1. Export `parseStreamJsonLine(line: string): BackendEventInput | null` where `BackendEventInput = Omit<BackendEvent, 'turn_id'>` (turn_id is injected by the caller since the CLI's output doesn't carry our synthetic turn ids).
- [ ] Task 1.2. Dispatch on `.type` + `.subtype`:
  - `type=system, subtype=init` → `{kind:'system.init', session_id}`
  - `type=system, subtype=hook_started|hook_response` → null
  - `type=assistant` → expand `.message.content[]`; each `{type:'text', text}` → `{kind:'assistant.delta', text}`; each `{type:'tool_use', id, name, input}` → `{kind:'tool.use', tool_use_id:id, name, input}`. Since a single CLI line can yield multiple events, the function signature actually returns `BackendEventInput[]`; PR #4 adapts the signature accordingly.
  - `type=user` → expand `.message.content[]`; `{type:'tool_result', tool_use_id, content, is_error?}` → `{kind:'tool.result'}` or `{kind:'tool.error', message: <string-form of content>}` when `is_error`.
  - `type=result, subtype=success` → `{kind:'turn.result', usage?}`
  - `type=result, subtype != success` → `{kind:'turn.error', error:{kind:'cli_crashed', retryable:true, detail: <stop_reason or result text>}}`
  - `type=rate_limit_event` or any unrecognized `type` → null (the real backend logs these at debug, but the parser itself stays silent + pure).
- [ ] Task 1.3. `parseStreamJsonLines(text: string): BackendEventInput[]` convenience. Splits on `\n`, drops blank lines, drops malformed JSON silently — the reason is that the parser must be robust to partial reads at buffer boundaries, and the tape recorder already splits on newlines.

### Section 2 — Parser tests (`packages/backend/tests/parse-stream-json.test.ts`)

- [ ] Task 2.1. Case-per-kind table test: one fixture line per recognized shape → expected events array. Fixtures adapted from the real probe output in §"Ground Truth" above.
- [ ] Task 2.2. Robustness cases: malformed JSON → empty array, unknown type → empty array, hook events → empty array, multi-block assistant message (text + tool_use) → two events in order.
- [ ] Task 2.3. The `session_id` on every non-init event is **not** surfaced (we only care about init's). Pin that explicitly.

### Section 3 — RealClaudeBackend.startTurn + cancel (`packages/backend/src/real.ts`)

- [ ] Task 3.1. Remove the `NotImplemented` throws. Implement `startTurn(req)`:
  1. `const { argv, stdin, cwd, env } = compose(req, {claudeBinary: this.binary})` (merged with `this.spawnEnv`).
  2. `const proc = Bun.spawn(argv, { cwd, env: mergedEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true })`.
  3. Pipe `stdin` bytes into `proc.stdin`, close it immediately (the CLI receives EOF and begins the turn).
  4. Register `proc` in a `Map<turn_id, Bun.Subprocess>` so `cancel` can find it.
  5. Consume `proc.stdout` as an async line reader: buffer bytes, emit on every `\n`. For each complete line, `parseStreamJsonLine(line)` (array), attach `turn_id`, `yield`.
  6. Await `proc.exited`. If non-zero exit **and** no `turn.result`/`turn.error` has been yielded yet, yield a synthesized `turn.error` with `{kind:'cli_crashed', retryable:true, exit_code, raw_stderr: <drained>}`.
  7. Clean up the map entry in a `finally`.
- [ ] Task 3.2. `cancel(turnId)`: look up the proc; if present, `process.kill(-proc.pid, 'SIGTERM')` (negative pid = pgid kill on Unix; we set `detached: true`). No ladder. If not present, resolve silently (already finished or never started).
- [ ] Task 3.3. Line reader helper is local to `real.ts`; a tiny generator over a `ReadableStream<Uint8Array>` + a `TextDecoder({stream:true})` + a split buffer.
- [ ] Task 3.4. `startTurn` error-paths: if `Bun.spawn` throws synchronously (ENOENT), yield `turn.error{kind:'cli_missing'}` and return. If `--version` was last reported as `missing`, short-circuit the same way without spawning.

### Section 4 — RealClaudeBackend shim tests (`packages/backend/tests/real-start-turn.test.ts`)

- [ ] Task 4.1. Synthetic bash shim helper (local to this file, same pattern as PR #2 probe tests): writes a script that prints canned NDJSON to stdout, optionally reads + discards stdin, optionally sleeps, exits with a given code. Sleep variants enable cancel tests.
- [ ] Task 4.2. Cases:
  - Shim prints `system.init` + one `assistant` text + `result.success` → backend yields `[system.init, assistant.delta, turn.result]` with correct turn_id on each and session_id propagated.
  - Shim prints `system.init` + `assistant` tool_use + `user` tool_result + `result.success` → includes `tool.use` and `tool.result` in between.
  - Shim exits non-zero with no `result` line → backend yields a synthesized `turn.error{cli_crashed, exit_code}`.
  - Binary missing (nonexistent absolute path) → yields `turn.error{cli_missing}`.
  - Shim ignores stdin (just sleeps), `cancel(turn_id)` → subprocess exits within 2s, no zombie left.

### Section 5 — Engine wire routes (`apps/engine/src/index.ts`)

- [ ] Task 5.1. Refactor `createApp` to accept a full `ClaudeBackend` (not `{health}`). Existing `/health` route continues to work (backend.health()).
- [ ] Task 5.2. Add `POST /conversations/:id/turns` — body: `{turn_id, user_message, model?, cwd?, ...}`. Kicks `backend.startTurn` in a detached Promise that broadcasts envelopes through an internal broadcaster callback supplied by the caller. Returns `202 {accepted: true}`.
- [ ] Task 5.3. Add `POST /conversations/:id/cancel` — body: `{turn_id}`. Calls `backend.cancel(turn_id)`. Returns `200 {accepted: true}`.
- [ ] Task 5.4. Add WebSocket at `/ws`. Uses `Bun.serve`'s upgrade flow. Every envelope broadcast is `JSON.stringify`-ed and sent to all live sockets. (Per-conversation topic subscription is Phase 2 Task 2.8 proper — for PR #4 everyone gets everything; filtering can land alongside replay buffers.)
- [ ] Task 5.5. The existing `import.meta.main` guard still starts the default app against `RealClaudeBackend`. The backend is `.start()`-ed at startup; on SIGINT/SIGTERM we also attempt to cancel any in-flight turns before exiting.

### Section 6 — T1.01 un-skip (observability half)

- [ ] Task 6.1. Rewrite `tests/spine/T1.01-new-conversation-captures-session-id.test.ts` to:
  - Build a ScriptedBackend with `script().init('sess-observable-abc').assistantText('ok').result().end()`.
  - Instantiate `createApp(scriptedBackend)` in-process; serve it with `Bun.serve({port: 0})`; capture the chosen port.
  - Connect `TypedTestClient`, submit turn, `awaitEvent({kind:'system.init'})`, assert `envelope.payload.session_id === 'sess-observable-abc'`.
  - Teardown in `finally`.
- [ ] Task 6.2. Nested `describe.skip('T1.01 persistence half (pending PR #6)', ...)` block with two tests whose bodies are just FIXME comments pointing at PR #6.

### Section 7 — Verification

- [ ] Task 7.1. `bun run ci:fast` green.
- [ ] Task 7.2. 10× consecutive `ci:fast`, zero flakes.
- [ ] Task 7.3. Post-run `ps` check for no `bun run apps/engine` or `claude` processes sharing our pgids.
- [ ] Task 7.4. Manual smoke: `bun run apps/engine/src/index.ts` + `curl POST /conversations/<uuid>/turns -d '{turn_id,user_message}'` + `ws://.../ws` shows real envelopes flowing. (Optional, gated by claude being authenticated.)

## Out of Scope (explicitly)

- Cancel ladder + `turn.cancelled` escalation → PR #5.
- Stderr error-taxonomy sniffers → PR #5.
- Pidfile + single-instance + zombie sweep → PR #5.
- `--include-partial-messages` true streaming → later (additive; composer flag flip).
- Per-conversation WS topic subscription + replay buffer → Phase 2 Task 2.8 proper (later PR).
- SQLite + manifest persistence (T1.01's persistence half) → PR #6.
- Transcript watcher → PR #7 (T1.11).
- Settings IO → PR #8 (T1.09 completes).

## Risks

1. **Bun.spawn `detached: true` semantics.** On macOS, `detached: true` puts the child in its own process group; `process.kill(-pid, sig)` signals the whole group. If Bun's behavior differs from Node's here, the cancel test catches it. Mitigation: the shim-based cancel test is tiny; switching to `pgkill` or an explicit `Bun.spawn` option is a one-line fix.
2. **Line-buffer boundary correctness.** NDJSON readers that flush per-chunk instead of per-`\n` emit half-parsed objects. Mitigation: helper buffers until `\n`, tests include a case where a single fixture line is split across two stdout chunks.
3. **Broadcast-to-all-sockets leaks cross-conversation events.** Acceptable for PR #4 (single-conversation personal app, local only). Mitigation: topic filtering lands with replay buffer in a later PR; today the client filters envelopes by `conv_id`.
4. **Test-suite wall-clock growth.** Each shim test spawns a bash subprocess. Mitigation: shims are ~10ms each; five tests adds ~50ms, well within the 2-min `ci:fast` budget.

## Open Items

- **PR description** should note the real stream-JSON shape discovered during the probe and link the Ground Truth section for anyone who wants to re-verify.
- **Follow-up plan file** for PR #5 (cancel ladder + error taxonomy + pidfile) drafted once this PR merges.
