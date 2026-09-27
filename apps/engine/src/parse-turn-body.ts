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
  if (body['system_prompt'] && typeof body['system_prompt'] === 'object') {
    const sp = body['system_prompt'] as Record<string, unknown>;
    if ((sp['mode'] === 'append' || sp['mode'] === 'override') && typeof sp['text'] === 'string') {
      req.system_prompt = { mode: sp['mode'], text: sp['text'] as string };
    }
  }
  return { ok: true, value: req };
}
