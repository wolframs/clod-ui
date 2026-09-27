/**
 * `GET /health` route registrar.
 *
 * Always-on (no opt-in). Returns the cached CLI probe status from the
 * backend plus engine metadata. Spec: plans/landed/2026-04-23-clod-ui-pr2-health-probe-v1.md.
 */
import type { ClaudeBackend } from '@clod-ui/backend';
import type { HealthResponse } from '@clod-ui/contracts';
import type { Hono } from 'hono';

export interface HealthRouteDeps {
  backend: ClaudeBackend;
  engineVersion: string;
  startedAt: number;
}

export function registerHealthRoutes(app: Hono, deps: HealthRouteDeps): void {
  app.get('/health', async (c) => {
    const status = await deps.backend.health();
    const body: HealthResponse = {
      cli: status.cli,
      engine_version: deps.engineVersion,
      started_at: deps.startedAt,
      ...(status.version !== undefined ? { version: status.version } : {}),
    };
    return c.json(body);
  });
}
