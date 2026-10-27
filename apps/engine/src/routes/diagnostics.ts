/**
 * `GET /diagnostics` route registrar (Phase 5.7, PR #32).
 *
 * Opt-in via `createApp({ diagnostics })` — absent configuration returns
 * the I-1 body `404 { error: 'diagnostics not configured' }`. The ring's
 * entries are already redacted (record-time, see diagnostics.ts).
 */
import type { Hono } from 'hono';

import type { DiagnosticsRing } from '../diagnostics.ts';

export interface DiagnosticsRouteDeps {
  ring: DiagnosticsRing | null;
}

export function registerDiagnosticsRoutes(app: Hono, deps: DiagnosticsRouteDeps): void {
  app.get('/diagnostics', (c) => {
    if (!deps.ring) {
      return c.json({ error: 'diagnostics not configured' }, 404);
    }
    return c.json({ turns: deps.ring.list() });
  });
}
