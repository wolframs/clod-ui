# PR #43 — warm sessions: group sweeps outlive the leader, session flags block reuse

_2026-10-27. Third review of PRs #39–#41 (Sol, relayed by the operator). Both
findings reproduced here by tests that fail without the fix._

## Findings

1. **`stop()` could return while a group sweep was still pending.** A handle
   left the `live` set as soon as its CLI leader exited. If the leader had
   already exited (a one-shot after its turn, or a crash), `stop()` did not
   wait for the SIGTERM → SIGKILL steps aimed at the descendants it left
   behind, and the engine's `process.exit()` could cut them off. A leader
   that exited on its own was never swept at all.
2. **Warm reuse ignored session controls in raw flags.** `splitArgv` sets
   every `--resume` pair aside and the rule checked only `resume_session_id`.
   A raw `--resume s2` (or `--fork-session`, `--continue`, `--session-id`, …)
   therefore still reused the process holding `s1`, and the flag was
   silently ignored.

## Decisions

1. A handle stays in `live` until its retirement promise settles. A leader's
   exit now triggers `retire()`, which sweeps the group. `stop()` already
   awaits `retire()` of every live handle, so it now waits for pending sweeps
   too.
2. `onlyResumes(argv, id)` checks that the only session control in the turn's
   argv is exactly one `--resume <resume_session_id>`. It covers the CLI
   2.1.310 session flags (`--resume`/`-r`, `--continue`/`-c`,
   `--fork-session`, `--session-id`, `--from-pr`, `--teleport`, `--bg`,
   `--no-session-persistence`, plus `--flag=value` forms). Anything else
   spawns fresh, and the CLI then does what the flags say.

## Tests

- Reuse table: raw `--resume s2`, `--fork-session`, `--continue`, `-c`,
  `--resume=s2`, `--session-id`, `--no-session-persistence`, and a resume id
  whose argv lacks `--resume`.
- Real backend: raw `--resume s2` spawns. A one-shot leaves a
  SIGTERM-ignoring child, and `stop()` waits until the child is dead. A warm
  leader that exits by itself has its child swept without `stop()`.
- Mutation-checked: putting either fix back fails its tests.
