/**
 * `GET/PUT/PATCH /settings` route registrars.
 *
 * Opt-in via `opts.settings`: when omitted, all three routes return 404
 * with `{ error: 'settings not configured' }`. Memory-only callers
 * (PR #4/#5 in-process tests) are unaffected.
 *
 * Errors are mapped through a single `settingsErrorResponse` helper:
 *   - `SettingsCorruptError` → 500 `{ kind: 'settings_corrupt', ... }`
 *   - `SettingsValidationError` + Zod failure on the wire → 400
 *     `{ kind: 'settings_invalid', ... }`
 *   - anything else → 500 `{ kind: 'unknown' }`
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §3.
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { ClaudeSettingsSchema } from '@clod-ui/contracts';
import type { SettingsStore } from '@clod-ui/settings';
import { SettingsCorruptError, SettingsValidationError } from '@clod-ui/settings';
import type { Hono } from 'hono';

export interface SettingsRouteDeps {
  store: SettingsStore | null;
}

export function registerSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  app.get('/settings', async (c) => {
    if (!deps.store) return c.json({ error: 'settings not configured' }, 404);
    try {
      const out = await deps.store.read();
      return c.json(out);
    } catch (err) {
      return settingsErrorResponse(c, err);
    }
  });

  app.put('/settings', async (c) => {
    if (!deps.store) return c.json({ error: 'settings not configured' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { kind: 'settings_invalid', detail: 'invalid JSON body' } }, 400);
    }
    const parsed = ClaudeSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            kind: 'settings_invalid',
            detail: 'one or more keys failed schema validation',
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }
    try {
      await deps.store.write(parsed.data);
      const out = await deps.store.read();
      return c.json(out);
    } catch (err) {
      return settingsErrorResponse(c, err);
    }
  });

  app.patch('/settings', async (c) => {
    if (!deps.store) return c.json({ error: 'settings not configured' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { kind: 'settings_invalid', detail: 'invalid JSON body' } }, 400);
    }
    // PATCH validates the *partial* shape: same schema, all keys still optional.
    const parsed = ClaudeSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            kind: 'settings_invalid',
            detail: 'one or more keys failed schema validation',
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }
    try {
      const merged = await deps.store.patch(parsed.data as Partial<ClaudeSettings>);
      return c.json(merged);
    } catch (err) {
      return settingsErrorResponse(c, err);
    }
  });
}

/**
 * Map a thrown settings error to a typed JSON response. `corrupt` errors are
 * 500 (the on-disk file is borked, not the caller's input); `validation`
 * errors are 400; everything else is 500 with `kind: 'unknown'`.
 */
function settingsErrorResponse(
  c: { json: (body: unknown, status?: number) => Response },
  err: unknown,
): Response {
  if (err instanceof SettingsCorruptError) {
    return c.json(
      {
        error: {
          kind: 'settings_corrupt',
          reason: err.reason,
          detail: err.message,
          ...(err.issues !== undefined ? { issues: err.issues } : {}),
        },
      },
      500,
    );
  }
  if (err instanceof SettingsValidationError) {
    return c.json(
      { error: { kind: 'settings_invalid', detail: err.message, issues: err.issues } },
      400,
    );
  }
  return c.json(
    { error: { kind: 'unknown', detail: err instanceof Error ? err.message : String(err) } },
    500,
  );
}
