/**
 * Static-asset fallback route registrar (opt-in).
 *
 * Serves the built web SPA (`apps/web/dist`) from the engine's origin so
 * the production app is same-origin — `apps/web/src/main.tsx` defaults
 * the engine base URL to `window.location` on exactly this assumption.
 *
 * Semantics (PR #21 plan §2):
 *   - GET-only catch-all, registered *last* — API routes win by
 *     registration order.
 *   - Exact file under `dir` → served (Bun infers Content-Type).
 *   - Anything else → `index.html` (SPA fallback for client routes).
 *   - Resolved paths escaping `dir` → 404. Never serves outside the root.
 *   - Deliberately NOT the I-1 `not configured` JSON body: static HTML is
 *     not a typed-client surface, and `GET /` must never hand a browser
 *     JSON. Unconfigured engines simply have no catch-all (404 as before).
 *
 * Spec: plans/2026-06-10-clod-ui-pr21-launcher-v1.md.
 */
import { join, resolve, sep } from 'node:path';

import type { Hono } from 'hono';

export interface StaticRouteDeps {
  /** Root directory of the built SPA, or null when the subsystem is off. */
  staticDir: string | null;
}

export function registerStaticRoutes(app: Hono, deps: StaticRouteDeps): void {
  if (deps.staticDir === null) return;
  const root = resolve(deps.staticDir);

  app.get('*', async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      return c.text('not found', 404);
    }
    const candidate = resolve(root, `.${pathname}`);
    // Traversal guard: the URL parser collapses most `..` segments before
    // we see them, but this is the contract, not the parser's behavior.
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return c.text('not found', 404);
    }
    const file = Bun.file(candidate);
    if (await file.exists()) {
      return new Response(file);
    }
    const index = Bun.file(join(root, 'index.html'));
    if (await index.exists()) {
      return new Response(index);
    }
    return c.text('not found', 404);
  });
}
