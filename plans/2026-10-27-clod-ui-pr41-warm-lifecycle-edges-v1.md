# PR #41 — warm lifecycle edges: turn ownership, group-scoped retirement

_2026-10-27. Second review round on PR #40 (GPT-6.1-Sol, relayed by the operator).
The reviewer reproduced both findings locally; both were confirmed here by
tests that fail without the fix._

## Findings

1. **A finished turn's late cleanup could kill the next turn.** PR #40 settles
   the process before it yields the terminator, so the engine can start turn 2
   on the same process while turn 1's generator is still suspended. Turn 1's
   `finally` then checked only `handle.busy`, saw turn 2's busy flag, and
   retired the process under it: `cli_crashed` about 1s later. The engine's
   order of operations hides this today, but the backend's settle-first
   contract invites exactly this handoff.
2. **Retirement measured success by the leader alone.** When the CLI exited
   on EOF, its descendants got one SIGTERM, and anything that ignored it
   outlived `stop()`.

## Decisions

1. `busy: boolean` becomes `owner: LineQueue | null`. Each turn's queue is its
   ownership token. `finally` retires only when `owner === sink`, and
   `release()` acts only for its owner. Idle checks become `owner === null`.
2. Retirement is done when the **process group** is empty. The ladder: close
   stdin, wait up to 1s for the leader; then, while `kill(-pgid, 0)` finds
   anything (EPERM counts as alive), send SIGTERM to the group and wait up to
   1s, then SIGKILL and wait up to 0.5s. Worst case stays at about 2.5s.
   `groupGoneWithin` polls every 25ms.

## Tests (`real-warm.test.ts`)

- Turn 1 is held at its result while turn 2 (slower than the EOF wait)
  takes over; turn 1 then finishes. Turn 2 must still end with
  `turn.result`, on the same, live process.
- A shim leaves a SIGTERM-ignoring child in its group, then exits on EOF.
  After `stop()` the child must be dead, within 4s. The test kills the child
  itself in `finally`, so a failing run cannot leak it.
- Mutation-checked: `owner !== null` in `finally` fails the first test; a
  leader-only ladder fails the second (and leaked the child, which is what
  the second test is for).
