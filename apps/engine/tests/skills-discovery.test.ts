import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { listSkills, parseSkillDescription } from '../src/skills-discovery.ts';

describe('parseSkillDescription', () => {
  test('extracts the description from frontmatter, quotes stripped', () => {
    expect(parseSkillDescription('---\nname: x\ndescription: Does things\n---\nBody')).toBe(
      'Does things',
    );
    expect(parseSkillDescription('---\ndescription: "Quoted desc"\n---\n')).toBe('Quoted desc');
  });

  test('returns undefined without frontmatter or without the field', () => {
    expect(parseSkillDescription('# Just markdown')).toBeUndefined();
    expect(parseSkillDescription('---\nname: x\n---\ndescription: not frontmatter')).toBe(
      undefined,
    );
  });

  test('only reads inside the leading block; never throws on junk', () => {
    expect(parseSkillDescription('')).toBeUndefined();
    expect(parseSkillDescription('---\n---\n')).toBeUndefined();
  });
});

describe('listSkills', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clod-ui-skills-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeSkill(dir: string, name: string, description?: string): void {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    const fm = description ? `---\ndescription: ${description}\n---\n` : '';
    writeFileSync(join(skillDir, 'SKILL.md'), `${fm}# ${name}\n`);
  }

  test('discovers both scopes, skips non-skills, sorts user-first then by name', async () => {
    const userDir = join(root, 'user-skills');
    const projDir = join(root, 'proj-skills');
    makeSkill(userDir, 'zeta', 'User skill Z');
    makeSkill(userDir, 'alpha');
    makeSkill(projDir, 'beta', 'Project skill B');
    mkdirSync(join(userDir, 'not-a-skill')); // no SKILL.md
    writeFileSync(join(userDir, 'stray-file.txt'), 'x'); // not a directory

    const skills = await listSkills([
      { scope: 'user', path: userDir },
      { scope: 'project', path: projDir },
    ]);
    expect(skills.map((s) => [s.scope, s.name])).toEqual([
      ['user', 'alpha'],
      ['user', 'zeta'],
      ['project', 'beta'],
    ]);
    expect(skills[1]?.description).toBe('User skill Z');
    expect(skills[0]?.description).toBeUndefined();
    expect(skills[2]?.path).toBe(join(projDir, 'beta'));
  });

  test('missing roots contribute nothing', async () => {
    const skills = await listSkills([
      { scope: 'user', path: join(root, 'does-not-exist') },
      { scope: 'project', path: join(root, 'also-missing') },
    ]);
    expect(skills).toEqual([]);
  });
});
