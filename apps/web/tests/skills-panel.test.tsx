/**
 * Variant tests for `<SkillsPanel />` (PR #31) — marker assertions (I-3).
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { SkillsPanel } from '../src/components/skills-panel.tsx';
import type { SkillsState } from '../src/lib/use-skills.ts';

const noop = (): void => {};

function html(state: SkillsState, open = true): string {
  return renderToString(<SkillsPanel open={open} state={state} onClose={noop} />);
}

describe('SkillsPanel', () => {
  test('closed renders nothing', () => {
    expect(html({ status: 'loading' }, false)).toBe('');
  });

  test('loading / not_configured / error variants', () => {
    expect(html({ status: 'loading' })).toContain('data-state="loading"');
    expect(html({ status: 'not_configured' })).toContain('data-state="not_configured"');
    const err = html({ status: 'error', error: { message: 'kaput' } as never });
    expect(err).toContain('data-state="error"');
    expect(err).toContain('kaput');
  });

  test('empty list gets its own variant', () => {
    const out = html({ status: 'ok', skills: [] });
    expect(out).toContain('data-state="empty"');
    expect(out).not.toContain('skills-row');
  });

  test('ok variant: one row per skill with name, scope, description', () => {
    const out = html({
      status: 'ok',
      skills: [
        { name: 'research', scope: 'user', path: '/u/research', description: 'Deep research' },
        { name: 'deploy', scope: 'project', path: '/p/deploy' },
      ],
    });
    expect(out).toContain('data-state="ok"');
    const rows = out.match(/data-test="skills-row"/g) ?? [];
    expect(rows.length).toBe(2);
    expect(out).toContain('data-skill-name="research" data-scope="user"');
    expect(out).toContain('data-skill-name="deploy" data-scope="project"');
    expect(out).toContain('Deep research');
    expect(out).toContain('/skill-name');
  });
});
