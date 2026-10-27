/**
 * T1.18 — Skills discovery route.
 *
 * Contract: `GET /skills` (opt-in) lists skill directories (those
 * containing SKILL.md) from the configured user + project roots with
 * best-effort frontmatter descriptions, sorted user-scope-first then by
 * name. Missing/empty roots yield `{ skills: [] }`. An unconfigured
 * engine answers the exact I-1 body `404 { error: 'skills not
 * configured' }` so the typed client discriminates `not_configured`.
 * Display-only by design — the CLI has no per-skill argv
 * (TODO(skills-enablement) in @clod-ui/backend).
 *
 * PR: plans/2026-06-12-clod-ui-pr31-skills-discovery-v1.md §D1/D2/D5.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clod-ui-t118-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeBackend(): ScriptedBackend {
  return new ScriptedBackend(script().init('s-18').assistantText('ok').result().end());
}

function makeSkill(dir: string, name: string, description?: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const fm = description ? `---\ndescription: ${description}\n---\n` : '';
  writeFileSync(join(skillDir, 'SKILL.md'), `${fm}# ${name}\n`);
}

async function getSkills(ctx: {
  app: { fetch: (req: Request) => Response | Promise<Response> };
}): Promise<Response> {
  return ctx.app.fetch(new Request('http://x/skills'));
}

describe('T1.18 skills discovery', () => {
  test('lists both scopes with descriptions, user-first then by name', async () => {
    const userDir = join(root, 'u');
    const projDir = join(root, 'p');
    makeSkill(userDir, 'research', 'Deep research');
    makeSkill(projDir, 'deploy', 'Ship it');
    mkdirSync(join(projDir, 'not-a-skill'));

    const ctx = createApp({
      backend: makeBackend(),
      skills: {
        dirs: [
          { scope: 'user', path: userDir },
          { scope: 'project', path: projDir },
        ],
      },
    });
    const res = await getSkills(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; scope: string; description?: string }>;
    };
    expect(body.skills.map((s) => [s.scope, s.name, s.description])).toEqual([
      ['user', 'research', 'Deep research'],
      ['project', 'deploy', 'Ship it'],
    ]);
  });

  test('missing roots yield an empty list, not an error', async () => {
    const ctx = createApp({
      backend: makeBackend(),
      skills: { dirs: [{ scope: 'user', path: join(root, 'missing') }] },
    });
    const res = await getSkills(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: [] });
  });

  test('unconfigured engine answers the exact I-1 not-configured body', async () => {
    const ctx = createApp({ backend: makeBackend() });
    const res = await getSkills(ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'skills not configured' });
  });
});
