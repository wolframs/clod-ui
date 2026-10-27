/**
 * Parse `POST /conversations/:id/turns` request bodies into a typed
 * `TurnRequest`. Pulled out of `routes/turns.ts` so it stays focused on
 * the HTTP+streaming choreography and the body-parsing rules can be
 * tested in isolation if needed.
 *
 * The shape mirrors what backend implementations (`RealClaudeBackend`,
 * `ScriptedBackend`) consume; missing/invalid fields return a typed
 * error string the caller surfaces as 400.
 */
import type { TurnRequest } from '@clod-ui/backend';
import { ThinkingEffortSchema } from '@clod-ui/contracts';

export type ParsedTurn = { ok: true; value: TurnRequest } | { ok: false; error: string };

export function parseTurnBody(convId: string, body: Record<string, unknown>): ParsedTurn {
  const turnId = body['turn_id'];
  if (typeof turnId !== 'string' || turnId.length === 0) {
    return { ok: false, error: 'turn_id is required (string)' };
  }
  const userMessage = body['user_message'];
  if (typeof userMessage !== 'string') {
    return { ok: false, error: 'user_message is required (string)' };
  }
  const cwd = typeof body['cwd'] === 'string' ? (body['cwd'] as string) : process.cwd();
  const req: TurnRequest = {
    turn_id: turnId,
    conv_id: convId,
    user_message: userMessage,
    cwd,
  };
  if (typeof body['model'] === 'string') req.model = body['model'] as string;
  // Deliberate asymmetry (PR #24, D3): `thinking_effort` is a closed
  // vocabulary we own, so an unrecognized value is a 400 — silently
  // dropping it would silently change thinking depth on the spawned CLI.
  if (body['thinking_effort'] !== undefined) {
    const effort = ThinkingEffortSchema.safeParse(body['thinking_effort']);
    if (!effort.success) {
      return {
        ok: false,
        error: `thinking_effort must be one of: ${ThinkingEffortSchema.options.join(', ')}`,
      };
    }
    req.thinking_effort = effort.data;
  }
  if (typeof body['resume_session_id'] === 'string') {
    req.resume_session_id = body['resume_session_id'] as string;
  }
  if (Array.isArray(body['allowed_tools'])) {
    const arr = body['allowed_tools'].filter((x): x is string => typeof x === 'string');
    if (arr.length > 0) req.allowed_tools = arr;
  }
  if (Array.isArray(body['disallowed_tools'])) {
    const arr = body['disallowed_tools'].filter((x): x is string => typeof x === 'string');
    if (arr.length > 0) req.disallowed_tools = arr;
  }
  // Same closed-vocabulary stance as thinking_effort (PR #25, D1): a
  // present-but-malformed system_prompt is a 400, not a silent drop —
  // dropping it would silently change what the model sees.
  if (body['system_prompt'] !== undefined) {
    const sp = body['system_prompt'];
    if (sp === null || typeof sp !== 'object' || Array.isArray(sp)) {
      return { ok: false, error: 'system_prompt must be an object { mode, text }' };
    }
    const { mode, text } = sp as Record<string, unknown>;
    if (mode !== 'append' && mode !== 'override') {
      return { ok: false, error: 'system_prompt.mode must be one of: append, override' };
    }
    if (typeof text !== 'string') {
      return { ok: false, error: 'system_prompt.text is required (string)' };
    }
    req.system_prompt = { mode, text };
  }
  // Raw argv is the sharpest control on the wire (PR #28, D2): silently
  // filtering a malformed element would spawn a different command than
  // the operator wrote, so any non-string element is a 400. An empty
  // array is argv-identical to absent and stays absent.
  if (body['extra_argv'] !== undefined) {
    const raw = body['extra_argv'];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
      return { ok: false, error: 'extra_argv must be an array of strings' };
    }
    if (raw.length > 0) req.extra_argv = raw as string[];
  }
  // Attachments (PR #33, D4): paths drive --add-dir — same strict stance
  // as extra_argv; a malformed entry is a 400, never a silent drop.
  if (body['attachments'] !== undefined) {
    const raw = body['attachments'];
    const valid =
      Array.isArray(raw) &&
      raw.every(
        (x) =>
          x !== null &&
          typeof x === 'object' &&
          !Array.isArray(x) &&
          typeof (x as Record<string, unknown>)['path'] === 'string' &&
          ((x as Record<string, unknown>)['content_type'] === undefined ||
            typeof (x as Record<string, unknown>)['content_type'] === 'string'),
      );
    if (!valid) {
      return { ok: false, error: 'attachments must be an array of { path, content_type? }' };
    }
    const arr = (raw as Array<{ path: string; content_type?: string }>).map((a) => ({
      path: a.path,
      ...(a.content_type !== undefined && { content_type: a.content_type }),
    }));
    if (arr.length > 0) req.attachments = arr;
  }
  return { ok: true, value: req };
}
