import type { TurnRequest } from './types.ts';

/**
 * Pure flag composer: maps a `TurnRequest` into the concrete shape we hand to
 * `Bun.spawn` (plus a stream-JSON stdin payload for the initial user message).
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 2.4.
 *       plans/landed/2026-04-23-clod-ui-pr3-flag-composer-v1.md §1.
 *
 * No I/O, no subprocess, no filesystem. The real spawn lives in
 * `RealClaudeBackend.startTurn` (PR #4) and consumes this result verbatim.
 */

/**
 * Effort level → the CLI's `--effort` value (PR #42: the CLI's own names).
 * `auto` sends no flag, so the model's default applies.
 */
export const THINKING_EFFORT_MAP: Readonly<
  Record<NonNullable<TurnRequest['thinking_effort']>, string | null>
> = {
  auto: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultracode: 'ultracode', // accepted by --effort though --help omits it (PR #42)
};

export interface ComposeOptions {
  /** Override the `claude` binary path / name (default: 'claude'). */
  claudeBinary?: string;
  /**
   * Raw-flags escape hatch (architecture Task 5.8). Appended verbatim *after*
   * all composed flags so a power user can add or override anything.
   */
  extraArgv?: string[];
}

export interface ComposeResult {
  /** Full argv passed to `Bun.spawn`, `argv[0]` is the binary. */
  argv: string[];
  /** Extra environment variables the composer chose to add (may be empty). */
  env: Record<string, string>;
  /** Stream-JSON stdin payload encoding the user's message + attachments. */
  stdin: Uint8Array;
  /** Working directory the subprocess should run in. */
  cwd: string;
  /**
   * Skills requested for this turn. Not currently producible as argv —
   * the CLI (2.1.175) resolves skills via `/skill-name` in the prompt
   * and exposes no per-skill flag (PR #31 investigation). Surfaced so
   * the caller can fail loudly if unhandled.
   */
  // TODO(skills-enablement): revisit when the CLI documents a per-skill
  // mechanism; discovery/display shipped in PR #31 (GET /skills).
  pendingSkills?: string[];
}

/**
 * Compose argv + env + stdin for a single turn. Pure, deterministic.
 *
 * The resulting argv always begins with:
 *   `<binary> -p --input-format stream-json --output-format stream-json --verbose`
 *
 * `--verbose` is required by `claude` when `--output-format=stream-json` is
 * used with `--print`, otherwise the CLI rejects the combination.
 */
export function compose(req: TurnRequest, opts: ComposeOptions = {}): ComposeResult {
  const binary = opts.claudeBinary ?? 'claude';
  const argv: string[] = [
    binary,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (req.resume_session_id !== undefined) {
    argv.push('--resume', req.resume_session_id);
  }
  if (req.model !== undefined) {
    argv.push('--model', req.model);
  }
  if (req.thinking_effort !== undefined) {
    const effort = THINKING_EFFORT_MAP[req.thinking_effort];
    if (effort !== null) argv.push('--effort', effort);
  }
  if (req.system_prompt !== undefined) {
    const flag = req.system_prompt.mode === 'append' ? '--append-system-prompt' : '--system-prompt';
    argv.push(flag, req.system_prompt.text);
  }
  if (req.allowed_tools && req.allowed_tools.length > 0) {
    argv.push('--allowedTools', ...req.allowed_tools);
  }
  if (req.disallowed_tools && req.disallowed_tools.length > 0) {
    argv.push('--disallowedTools', ...req.disallowed_tools);
  }

  // --add-dir: the conversation's own cwd, plus every attachment's directory
  // (so that `Read` can succeed against attachments even if they live outside
  // cwd). Deduped; directories only — we strip filenames via `dirname`-style.
  const addDirs = new Set<string>();
  addDirs.add(req.cwd);
  for (const att of req.attachments ?? []) {
    addDirs.add(dirname(att.path));
  }
  for (const dir of addDirs) {
    argv.push('--add-dir', dir);
  }

  // Escape-hatch tail (Task 5.8): backend-level config first, then the
  // per-turn wire field — most specific last, so it wins by trailing
  // duplication (the CLI's last-flag-wins behavior, pinned in tests).
  if (opts.extraArgv && opts.extraArgv.length > 0) {
    argv.push(...opts.extraArgv);
  }
  if (req.extra_argv && req.extra_argv.length > 0) {
    argv.push(...req.extra_argv);
  }

  const result: ComposeResult = {
    argv,
    env: {},
    stdin: encodeStdin(req),
    cwd: req.cwd,
  };
  if (req.skills && req.skills.length > 0) {
    result.pendingSkills = [...req.skills];
  }
  return result;
}

/**
 * Encode the first user message as a single stream-JSON line.
 *
 * Shape (best-effort per `claude --help` + SDK docs, to be pinned by a real
 * tape in PR #4):
 *
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}, {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]}}
 *
 * Pinned by the PR #33 real-CLI smoke: image blocks need the API-standard
 * base64 source (a path source is rejected and stripped). Non-image
 * attachments rely on `--add-dir` + tool-driven retrieval.
 */
function encodeStdin(req: TurnRequest): Uint8Array {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.user_message }];
  for (const att of req.attachments ?? []) {
    // Real-CLI evidence (PR #33 smoke): a path-source image block is
    // rejected ("image could not be processed"); the API-standard base64
    // source is what stream-json input accepts. Images without loaded
    // bytes fall back to tool-driven retrieval via --add-dir.
    if (isImageContentType(att.content_type) && att.data_base64 !== undefined) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: att.content_type, data: att.data_base64 },
      });
    }
    // non-image attachments: tool-driven retrieval via --add-dir (no inline).
  }
  const payload = {
    type: 'user',
    message: { role: 'user', content },
  };
  return new TextEncoder().encode(JSON.stringify(payload) + '\n');
}

function isImageContentType(ct: string | undefined): boolean {
  return typeof ct === 'string' && ct.startsWith('image/');
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}
