/**
 * `GET /models` route registrar (PR #42): the CLI's own model list.
 *
 * Configured when the backend can list models (`ClaudeBackend.listModels`);
 * otherwise the I-1 body `404 { error: 'models not configured' }`. A probe
 * failure (CLI missing, not logged in, timeout) is a 502 with the reason.
 *
 * Spec: plans/landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md §3.
 */
import type { ClaudeBackend } from '@clod-ui/backend';
import type { Hono } from 'hono';

export interface ModelsRouteDeps {
  backend: ClaudeBackend;
  /** Where the probe runs, so project settings apply (the conversations' cwd). */
  cwd?: string;
}

export function registerModelsRoutes(app: Hono, deps: ModelsRouteDeps): void {
  app.get('/models', async (c) => {
    const { backend } = deps;
    if (backend.listModels === undefined) {
      return c.json({ error: 'models not configured' }, 404);
    }
    try {
      const models = await backend.listModels(deps.cwd !== undefined ? { cwd: deps.cwd } : {});
      return c.json({ models, fetched_at: Date.now() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
}
