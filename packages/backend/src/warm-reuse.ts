/**
 * Whether a conversation's warm CLI process can serve the next turn (PR #39).
 *
 * A warm process was spawned with some argv and is now waiting on stdin for
 * another stream-json user message. Feeding it the next turn is equivalent to
 * a fresh `--resume` spawn only when nothing the CLI reads at startup differs:
 *
 *  - same cwd (CLAUDE.md, hooks, MCP config load from it);
 *  - same argv once `--resume <sid>` and the `--add-dir <dir>` pairs are set
 *    aside (model, effort, prompts, tools and raw flags all live in argv);
 *  - the turn resumes exactly the warm process's session — a turn with no
 *    resume id asks for a fresh session and never reuses, and so does one
 *    whose argv carries any other session control (PR #43);
 *  - every directory the turn needs was already added to the warm process.
 *
 * Pure: no I/O. Spec: plans/landed/2026-10-27-clod-ui-pr39-warm-sessions-v1.md §2.
 */

export interface WarmProcessShape {
  argv: readonly string[];
  cwd: string;
  /** Session id from the process's `system/init`; undefined before the first one. */
  sessionId?: string;
}

export interface NextTurnShape {
  argv: readonly string[];
  cwd: string;
  resume_session_id?: string;
}

interface SplitArgv {
  rest: string[];
  addDirs: Set<string>;
}

/** Separate `--resume <x>` and `--add-dir <x>` pairs from the rest of argv. */
export function splitArgv(argv: readonly string[]): SplitArgv {
  const rest: string[] = [];
  const addDirs = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === '--resume' || a === '--add-dir') && i + 1 < argv.length) {
      if (a === '--add-dir') addDirs.add(argv[i + 1]!);
      i++;
      continue;
    }
    rest.push(a);
  }
  return { rest, addDirs };
}

/**
 * The CLI's session-control flags (CLI 2.1.310 `--help`). A turn's argv
 * may carry exactly one: the composed `--resume <resume_session_id>`.
 */
const SESSION_FLAGS = new Set([
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--session-id',
  '--from-pr',
  '--teleport',
  '--bg',
  '--background',
  '--no-session-persistence',
]);

/**
 * True when the only session control in `argv` is one `--resume <id>`
 * (PR #43). Anything else — a raw-flags `--resume s2`, `--fork-session`,
 * `--continue`, `--session-id`, `--resume=…` — asks for a different session
 * than the warm process holds, so the turn needs a fresh spawn.
 */
export function onlyResumes(argv: readonly string[], id: string): boolean {
  let resumes = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const flag = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (!SESSION_FLAGS.has(flag)) continue;
    if (a === '--resume' && argv[i + 1] === id && resumes === 0) {
      resumes++;
      i++;
      continue;
    }
    return false;
  }
  return resumes === 1;
}

export function warmReusable(warm: WarmProcessShape, next: NextTurnShape): boolean {
  if (warm.cwd !== next.cwd) return false;
  if (next.resume_session_id === undefined) return false;
  if (!onlyResumes(next.argv, next.resume_session_id)) return false;
  if (warm.sessionId === undefined || warm.sessionId !== next.resume_session_id) return false;
  const w = splitArgv(warm.argv);
  const n = splitArgv(next.argv);
  if (w.rest.length !== n.rest.length) return false;
  for (let i = 0; i < w.rest.length; i++) {
    if (w.rest[i] !== n.rest[i]) return false;
  }
  for (const dir of n.addDirs) {
    if (!w.addDirs.has(dir)) return false;
  }
  return true;
}
