# PR #11 — `DefaultTitler` (claude -p, Haiku)

**Status:** Implementation
**Spec:** `plans/2026-04-23-clod-ui-architecture-v2.md` Task 3.5 (LLM half)
**Depends on:** PR #10 (Titler interface, FallbackTitler, engine wiring, `conversation.titled` event kind)

## Charter

Swap the production titler from the deterministic fallback to an LLM-backed
implementation. The architecture spec:

> after the first `turn.result`, dispatch a secondary headless `claude -p`
> with a minimal prompt asking for a 4–6 word title; on failure or timeout,
> **fall back to a date+first-words title**.

PR #10 landed the entire lifecycle (trigger, manifest event, broadcast,
idempotency, race guard) plus the fallback path. This PR drops in a
`DefaultTitler` behind the same `Titler` interface — no engine wiring change,
no manifest schema change, no wire taxonomy change. The single line in the
production entrypoint changes from `new FallbackTitler()` to
`new DefaultTitler({...})`.

The `Titler` contract is unchanged: `suggestTitle` always returns a
non-empty string. The DefaultTitler delegates to its internal fallback on
**every** failure mode (spawn error, non-zero exit, timeout, empty output,
malformed output). Failures are non-fatal and never propagate to the caller.

## Why Haiku

Title generation is small-input, small-output, latency-sensitive,
cost-sensitive. Haiku is sized exactly for this — a 4-6 word summary lands
well under a second of model time and at a fraction of Sonnet's per-token
cost. The codebase already uses `haiku` as the canonical short alias
(`packages/test-kit/tests/tape-backend.test.ts:44`,
`packages/test-kit/tests/assertions.test.ts:65`), so we default to that.
Users can override with a full model id if they want to pin a specific
revision.

## Non-goals (in this PR)

- **Streaming the title back as it generates.** The wire event is a single
  `conversation.titled { title }` envelope — there is no `title.delta`
  surface and the architecture doesn't ask for one. Haiku at this size
  generates faster than the manifest fsync round-trip; streaming is YAGNI.
- **Per-conversation model override.** No `titler.model` field in
  `ClaudeSettings`. If someone wants to swap models, they construct
  `DefaultTitler` differently at engine startup. A future settings field
  is a one-liner when actually needed.
- **Re-titling.** The "first auto-title wins" invariant established in
  PR #10 still holds. The engine's `maybeTitle` worker re-checks the
  manifest after the titler resolves and never overwrites. PR #11 is purely
  a swap of the titler implementation.
- **Reusing `RealClaudeBackend`.** The streaming-turn surface there
  (cancel ladder, stream-JSON parsing, per-turn lifecycle) is overkill
  for a one-shot synchronous string-in / string-out call. Keep them
  separate.

## Design

### Public API

```ts
export interface DefaultTitlerOptions {
  /** CLI binary (path or PATH name). Default: 'claude'. */
  claudeBinary?: string;
  /** Model alias or id passed to `--model`. Default: 'haiku'. */
  model?: string;
  /** Wall-clock budget for the spawn (ms). Default: 5000. */
  timeoutMs?: number;
  /** Working directory for the spawn. Default: process.cwd(). */
  cwd?: string;
  /** Extra env vars merged over the inherited env. Default: none. */
  env?: Record<string, string>;
  /**
   * Maximum input characters of `user_message` and `assistant_text`
   * passed into the prompt. Defaults: 1000 each.
   */
  maxUserMessageChars?: number;
  maxAssistantChars?: number;
  /**
   * Test seam: if provided, this function is invoked instead of spawning
   * the CLI. Receives the constructed prompt + argv + budget; returns the
   * raw stdout (which the titler then cleans). Throw to simulate a CLI
   * failure path.
   */
  invokeForTest?: (args: {
    prompt: string;
    argv: string[];
    timeoutMs: number;
  }) => Promise<string>;
  /**
   * Fallback titler used on every failure path. Default: `new FallbackTitler()`.
   * Override only for tests that want to assert the fallback was invoked.
   */
  fallback?: Titler;
}

export class DefaultTitler implements Titler {
  constructor(opts?: DefaultTitlerOptions);
  suggestTitle(input: TitlerInput): Promise<string>;
}
```

### Prompt template

Minimal, deterministic, Haiku-friendly:

```
Read the conversation excerpt below and respond with a 4-6 word title that summarizes its topic. Reply with the title only — no quotes, no preamble, no trailing period.

User: <user_message-truncated>
Assistant: <assistant_text-truncated>

Title:
```

The trailing `Title:` is the output anchor; everything before the model's
first newline after that anchor is the candidate title. Haiku's instruction
following on prompts this short is reliable; we don't need few-shot examples.

Truncation: if `user_message` or `assistant_text` exceeds its char budget,
truncate at the budget boundary and append ` …` so Haiku knows the input
was clipped. Defaults are 1000 each — comfortably within argv length limits
and irrelevant for ~95% of real turns.

### Argv

```
[binary, '-p', prompt, '--model', model, '--output-format', 'text']
```

`--output-format text` returns plain stdout text rather than the
stream-JSON envelope structure the streaming backend uses. Simpler parse
(no JSON), simpler timeout semantics. `--verbose` is *not* added — that
flag is only required when `--output-format=stream-json`.

`--add-dir` and `--allowedTools` are deliberately omitted: the title
prompt does no tool use, so there's nothing to allow and nothing to share.

### Spawn semantics

```
proc = Bun.spawn(argv, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
```

A timer of `timeoutMs` (default 5000) fires `proc.kill('SIGKILL')` if the
process is still alive when it expires; in that case the output is
considered failed and the fallback runs. We do **not** use the
SIGINT→SIGTERM→SIGKILL ladder from `RealClaudeBackend` — for a one-shot
title call that nobody is watching, an immediate SIGKILL is fine.
Background-work brutality.

Exit-code semantics: any non-zero exit triggers fallback. Stderr is
captured for logging but the titler does **not** re-classify it (no
`classifyCliFailure` invocation) — the only outcomes the engine cares
about are "title produced" and "use fallback".

### Output cleaning

Haiku's reply through the `Title:` anchor is *almost always* a clean
title, but we defend against:

- Surrounding quotes (`"…"`, `'…'`, ` `…` `).
- A leading `Title:` if the model echoed the anchor.
- Trailing periods, commas, semicolons.
- Multiple lines — only the first non-empty trimmed line is taken.
- Markdown emphasis: `**…**`, `*…*`, `__…__`, `_…_` stripped.
- Word count outside [1, 12] → fallback. The architecture says 4-6 but
  we tolerate a wider band; >12 words almost always means the model
  produced an essay instead of a title.

After cleaning, if the result is empty or whitespace, fall back.

### Fallback delegation

```ts
const fallback = opts.fallback ?? new FallbackTitler();
// every failure path:
return fallback.suggestTitle(input);
```

The `Titler` contract guarantees `fallback.suggestTitle` always returns a
non-empty string, so `DefaultTitler.suggestTitle` does too — even if both
the LLM call *and* the user_message are empty, `FallbackTitler` falls
through to the date-stamped string.

### Wiring change

Single-line in `apps/engine/src/index.ts:653`:

```diff
- titler: new FallbackTitler(),
+ titler: new DefaultTitler(),
```

The default constructor is opinionated (`claude` binary on PATH, model
'haiku', 5s budget). Operators with custom needs construct it with
options.

## Tests

### Unit tests (`apps/engine/tests/default-titler.test.ts`)

All tests use the `invokeForTest` seam — no actual subprocess spawns.
This makes them deterministic and fast.

#### Happy paths

1. **Clean Haiku reply**: `invokeForTest` returns `'Refactor the login form'`.
   `suggestTitle` returns it verbatim. No fallback invoked.
2. **Reply with surrounding double quotes**: `'"Refactor the login form"'`
   → cleaned to `Refactor the login form`.
3. **Reply with surrounding single quotes**: `"'Foo bar baz'"` → cleaned.
4. **Reply with backticks**: `` '`Foo bar baz`' `` → cleaned.
5. **Reply with `Title:` echo**: `'Title: Refactor login flow'` → cleaned.
6. **Reply with trailing period**: `'Foo bar baz.'` → cleaned.
7. **Reply with markdown emphasis**: `'**Foo bar baz**'` → cleaned to `Foo bar baz`.
8. **Reply with extra whitespace**: `'   Foo bar baz   '` → cleaned.
9. **Reply with multiple lines**: `'Foo bar baz\nIgnored explanation'` →
   first line only.

#### Fallback delegations

10. **Empty stdout** → fallback invoked.
11. **Whitespace-only stdout** → fallback invoked.
12. **Single-word reply** ('Foo') → titler accepts (>=1 word in [1, 12]).
13. **20-word reply** (overshoots band) → fallback invoked.
14. **`invokeForTest` throws** → fallback invoked, suggestTitle still returns
    a non-empty string.

#### Argv composition

15. **Default options** → argv contains `'-p'`, `'--model'`, `'haiku'`,
    `'--output-format'`, `'text'`.
16. **Custom binary + model** → argv reflects them.
17. **Prompt contains user_message and assistant_text** with the literal
    `Title:` anchor.
18. **User message and assistant text are truncated** at their respective
    char budgets when oversized; truncation marker (` …`) appears.

#### Timeout

19. **`invokeForTest` rejects with a timeout-shaped error** → fallback
    invoked. (No real timer assertion; we test the failure-path branch.)

### Integration with engine

PR #10's `auto-titling.test.ts` already covers the engine's wiring of
*any* `Titler` implementation (idempotency, race guard, conv_id routing,
opt-in surface). PR #11 adds no new integration tests because the engine
sees no behavior difference — the titler is still just a `Titler`.

## What unblocks next

- **Phase 4 sidebar route** (`GET /conversations`): list with projected
  titles. With `DefaultTitler` shipping by default, real conversations
  land with model-derived titles immediately.
- **Settings field for model override** (Phase 4+): when a UI lets users
  pick the titling model, we add an `auto_title.model` field to
  `ClaudeSettings` and read it at engine startup.
- **Manual retitle endpoint**: still deferred. Same architecture as PR #10
  — append `conversation.titled` from a `PUT /conversations/:id/title`
  route; the fold's last-write-wins semantics already handle it.

## Summary

PR #11 is a pure-implementation slice: one new module (`default-titler.ts`),
one wiring-line swap, ~19 unit tests against the `invokeForTest` seam.
Total surface delta: roughly +250 lines of code, +250 lines of tests,
+0 manifest events, +0 routes, +0 schema changes.
