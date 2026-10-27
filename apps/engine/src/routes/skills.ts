/**
 * `GET /skills` route registrar (Phase 5.6 step 1, PR #31).
 *
 * Opt-in via `createApp({ skills: { dirs } })` — absent configuration
 * returns the I-1 body `404 { error: 'skills not configured' }` so the
 * typed client discriminates `kind: 'not_configured'`.
 */
import type { Hono } from 'hono';

import type { SkillsDir } from '../skills-discovery.ts';
import { listSkills } from '../skills-discovery.ts';

export interface SkillsRouteDeps {
  skills: { dirs: SkillsDir[] } | null;
}

export function registerSkillsRoutes(app: Hono, deps: SkillsRouteDeps): void {
  app.get('/skills', async (c) => {
    if (!deps.skills) {
      return c.json({ error: 'skills not configured' }, 404);
    }
    const skills = await listSkills(deps.skills.dirs);
    return c.json({ skills });
  });
}
