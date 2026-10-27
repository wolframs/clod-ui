# PR #32 — Phase 5.7: diagnostics panel (completion goal S8)

Date: 2026-06-12. Spec: completion goal S8; v2 Task 5.7. Substrate:
`compose()` is pure (re-callable for the record without touching the
spawn); `routes/turns.ts` already pumps every backend event through one
loop; test-kit's `ScriptedBackend` consumes `{ events: PendingEvent[] }`
(`BackendEvent` minus `turn_id`) — the repro target.

## Objective

Per-turn diagnostics, wire-only: what argv would spawn (system-prompt
text redacted), env key names, stdin byte size, the event timeline, and
the outcome — visible in a hidden-by-default panel whose "Copy repro"
emits JSON a ScriptedBackend can replay.

## Pinned decisions

- **D1 — redaction at record time, never at render time.** Pure
  `redactArgv(argv)`: the value following `--system-prompt` /
  `--append-system-prompt` becomes `[redacted <n> chars]`. The ring
  never holds the raw text, so no later surface can leak it. Raw flags
  and other args pass through (the goal pin redacts system-prompt text
  specifically); stdin is recorded as a byte count only (it carries the
  user message). Env: key names only.
- **D2 — `DiagnosticsRing` (engine module), bounded by turn count.**
  Default capacity 50, oldest evicted. Entry: `{ turn_id, conv_id,
  started_at, argv (redacted), env_keys, stdin_bytes, cwd, events:
  Array<{ ts, kind, event }>, outcome? }` where `event` is the raw
  `PendingEvent` (turn_id stripped) — the timeline derives from
  `ts`+`kind`, the repro from `event`. `outcome` = `{ kind: 'result' |
  'cancelled' | 'error', detail? }` set on terminator or iterator throw.
  Wire-only by I-8: the ring lives in memory; nothing touches the
  manifest.
- **D3 — recording hooks in `routes/turns.ts`.** On accept: `ring.start`
  with `compose(req)`'s argv/env/stdin (pure recompute; RealClaudeBackend
  composes identically at spawn). In the pump: `ring.addEvent`. On
  terminator / throw / finally: `ring.finish`. Ring optional — zero work
  when diagnostics are off.
- **D4 — `GET /diagnostics`, opt-in (I-1):** `404 { error: 'diagnostics
  not configured' }` absent; else `{ turns: [...] }` most recent first.
  `createApp({ diagnostics: { capacity? } })`; production entrypoint
  enables it unconditionally (localhost-only engine; the data is the
  operator's own traffic). Zod schemas in contracts (`event` as
  `z.unknown()`), `client.getDiagnostics()`.
- **D5 — repro JSON.** `{ request: { turn_id, conv_id, cwd, stdin_bytes,
  argv }, events: PendingEvent[] }` — `events` is exactly what
  `new ScriptedBackend({ events })` accepts. Round-trip pinned by an
  engine unit test: parse the panel's JSON → ScriptedBackend → replay
  yields the same kind sequence + payloads.
- **D6 — UI: hidden-by-default panel**, footer "Debug" button (same
  modal pattern as settings/skills; Escape chain gains it last).
  `useDiagnostics` (I-2, fetch-on-open). Rows are native `<details>`
  disclosures (no state hook needed): summary = turn id + outcome +
  event count; body = argv tokens, env keys, stdin bytes, timeline,
  Copy-repro button (`navigator.clipboard`, defensively guarded).
- **D7 — spine: new contract T1.19**: (1) a turn with a system prompt
  records redacted argv (contains `[redacted`, not the text) + env keys
  + stdin_bytes + ordered timeline + `result` outcome; (2) ring bounds
  + most-recent-first across multiple turns; (3) unconfigured → exact
  I-1 404 body. 42 → 45 tests, 19 files.
- **D8 — markers (I-3).** `diagnostics-panel` (`data-state`),
  `diagnostics-row` (+ `data-turn-id`, `data-outcome`),
  `diagnostics-argv`, `diagnostics-timeline`, `diagnostics-copy-repro`;
  footer `diagnostics-open`.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Engine pure-ish core:** `diagnostics.ts` (`redactArgv` +
   `DiagnosticsRing`) + unit tests (redaction table, bounds/eviction,
   ordering, repro round-trip into ScriptedBackend).
3. **Wire:** contracts schemas + `client.getDiagnostics()`;
   `routes/diagnostics.ts`; createApp option + turns-route hooks +
   production enable; spine T1.19 + SPINE.md.
4. **Web:** `use-diagnostics.ts` (+ dom lifecycle tests),
   `diagnostics-panel.tsx` (+ bun variants; dom test for copy-repro
   with a stubbed clipboard), footer button + App wiring.
5. **Docs:** counts, CLAUDE.md WIP + file map, PROGRESS, goal doc S8,
   rotate plan, INDEX (both halves), NEXT-SESSION.md.

## Deferred (named, deliberate)

- Wire envelopes for live diagnostics push — the panel refetches on
  open; a `diagnostics.updated` event is not worth a wire kind yet.
- Redacting arbitrary user-marked-secret flags — `TODO(redact-config)`
  planted at `redactArgv`.

## Commits

1. `docs(plans): PR #32 diagnostics plan + INDEX row`
2. `feat(engine): redactArgv + DiagnosticsRing + repro round-trip (pure core)`
3. `feat(contracts,engine): GET /diagnostics route + turn recording + spine T1.19`
4. `feat(web): diagnostics panel with Copy repro`
5. `docs: land PR #32 — rotate plan, SPINE/CLAUDE/PROGRESS refresh`
