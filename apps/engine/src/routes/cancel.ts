/**
 * `POST /conversations/:id/cancel` route registrar.
 *
 * Stateless on the engine side — backend.cancel() owns the SIGINT→SIGTERM
 * →SIGKILL ladder (PR #5). This route just validates the request body and
 * forwards the turn_id.
 */
import type { ClaudeBackend } from '@clod-ui/backend';
import type { Hono } from 'hono';

export interface CancelRouteDeps {
  backend: ClaudeBackend;
}

export function registerCancelRoutes(app: Hono, deps: CancelRouteDeps): void {
  app.post('/conversations/:id/cancel', async (c) => {
    let body: { turn_id?: unknown };
    try {
      body = (await c.req.json()) as { turn_id?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const turnId = body.turn_id;
    if (typeof turnId !== 'string') {
      return c.json({ error: 'turn_id must be a string' }, 400);
    }
    await deps.backend.cancel(turnId);
    return c.json({ accepted: true });
  });
}
