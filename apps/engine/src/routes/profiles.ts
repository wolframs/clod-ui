/**
 * `GET /profiles` route registrar (PR #45). Always on: the implicit profile
 * always exists. Ids and labels only — binaries and cwds stay in the engine.
 * `warning` says why the registry file as it stands was not taken.
 *
 * Spec: plans/2026-11-05-clod-ui-pr45-profiles-v1.md §D7.
 */
import type { ProfilesResponse } from '@clod-ui/contracts';
import type { Hono } from 'hono';

import type { ProfileSource } from '../profiles.ts';

export interface ProfilesRouteDeps {
  profiles: ProfileSource;
}

export function registerProfilesRoutes(app: Hono, deps: ProfilesRouteDeps): void {
  app.get('/profiles', (c) => {
    const { registry, warning } = deps.profiles.current();
    const body: ProfilesResponse = {
      default: registry.default,
      profiles: registry.profiles.map((p) => ({ id: p.id, label: p.label })),
      ...(warning !== undefined && { warning }),
    };
    return c.json(body);
  });
}
