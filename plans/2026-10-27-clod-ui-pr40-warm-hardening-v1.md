# PR #40 — warm-session hardening: bounded retirement, one stdout pump, no forks

_2026-10-27. Follows PR #39 after a review (GPT-6.1-Sol, relayed by the operator):
"Fix what's broken, harden what can be hardened without creating leaks and
expensive overhang"._

## Review findings, triaged

1. **Retirement was not bounded.** `retire()` closed stdin and scheduled an
   unref'd SIGTERM, with no SIGKILL. `stop()` did not wait for it, so the engine's
   `process.exit(0)` could beat the escalation. Closing stdin only stops an
   *idle* CLI; one that is in the middle of a turn keeps going. PR #39's recap
   claimed "no orphans", which was overstated. **Real.**
2. **Late stdout.** A line printed after `result` sat in the pipe and was read
   by the next turn. **Real**, though no probe has seen one yet.
3. **Collision fallback could fork the session.** It also had a trigger I did
   not see at the time: `startTurn` yielded `turn.result` *before* setting
   `busy = false`. The engine broadcasts while the generator is suspended, so
   a fast next POST could find the warm process "busy" and spawn a one-shot
   `--resume` beside it. After that, the warm process's in-memory history was
   behind the session file, and the next reuse forked it. **Real.**
4. stderr unbounded; no cap on warm processes. **Cheap; taken.**

## Decisions

1. **Retirement is a bounded, awaitable ladder.** Close stdin, wait 1s, SIGTERM
   the process group, wait 1s, SIGKILL, wait 0.5s. When the leader exits,
   SIGTERM the group anyway so its leftover descendants (hooks, tool
   children) go with it. `retire()` returns one memoised promise. `stop()`
   retires **every** live process (warm, busy and one-shot, tracked in a
   `live` set) and awaits them all, worst case about 2.5s. That is inside the
   launcher's 5s SIGINT grace.
2. **One stdout pump per process**, running from spawn to EOF. It hands lines
   to the attached turn's queue. With no turn attached, the line is a stray:
   it is dropped and logged. A **reused** turn also drops lines that produce
   events until its own `system/init` arrives. The exception is a `result`
   line, which is accepted as this turn's terminator: one message produces
   one result, so the stale tail of an earlier turn can never contain one.
   Per-turn `system/init` is pinned by the PR #39 probes against CLI 2.1.310.
3. **Settle before announcing.** The process's state (busy → false and the idle
   timer armed, or retirement started) is updated *before* the terminator is
   yielded.
4. **Collision is an error, not a fallback.** If the warm process is busy,
   the turn gets `turn.error{unknown}` explaining the busy process. The
   engine's one-turn-per-conversation rule should make this unreachable.
5. **Caps.** stderr keeps the last 64 KiB per turn. `warmMax` (engine:
   `CLOD_UI_WARM_MAX`, default 4) limits warm processes. When the cap is hit,
   the least recently used idle one is retired; if every warm process is
   busy, the new turn runs as a one-shot.

## Not done

- `TODO(pidfile)` (Task 2.9) still covers an engine that is SIGKILLed: its idle
  CLIs exit on EOF, but one in the middle of a turn finishes that turn first.
- `TODO(warm-interrupt)` stays as it is.

## Tests (`real-warm.test.ts`)

- A stray line printed while idle never reaches the next turn.
- A fast next turn, sent right after the result is yielded, reuses the
  process and does not collide.
- A collision while busy produces `turn.error` and no second spawn.
- A shim that ignores EOF and SIGTERM is SIGKILLed; `stop()` resolves within
  the ladder's budget.
- The cap retires the LRU idle process.
- stderr is capped.

The engine-level smoke runs the real CLI against a hook brief. It counts
SessionStart runs and brief copies in the transcript, and times turn 1
against turn 2.

## Results (engine smoke, CLI 2.1.310, haiku, ~1k-token timestamped brief)

| 3 turns             | warm (default)        | cold (`WARM_IDLE_MS=0`)  |
| ------------------- | --------------------- | ------------------------ |
| SessionStart runs   | 1 (startup)           | 3 (startup, resume ×2)   |
| brief copies sent   | 1                     | 3                        |
| turn 2/3 init after | 15 / 25 ms            | 4.6 / 4.4 s              |
| turn 2/3 done after | 1.5 / 1.7 s           | 6.9 / 6.8 s              |
| turn 2/3 cache write| 132 / 51 tokens       | 956 / 872 tokens         |
| engine SIGINT exit  | 384 ms, 0 CLI left    | 7 ms, 0 CLI left         |

Mutation check: with the init gate off, or the release moved back after the
yield, the stray-line test or the fast-next-turn test fails, in that order.
