/**
 * Skills discovery (Phase 5.6 step 1, PR #31).
 *
 * A skill is a directory containing `SKILL.md` under a skills root
 * (`~/.claude/skills` user scope, `<cwd>/.claude/skills` project
 * scope). Discovery is read-only by design — the CLI resolves skills
 * via `/skill-name` in the prompt and exposes no per-skill argv, so
 * there is nothing to enable from here (see TODO(skills-enablement)
 * in @clod-ui/backend's ComposeResult.pendingSkills).
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { SkillScope, SkillSummary } from '@clod-ui/contracts';

export interface SkillsDir {
  scope: SkillScope;
  path: string;
}

/**
 * Best-effort `description:` from a SKILL.md's leading `---` frontmatter
 * block. Not a YAML parser: one field, first match, surrounding quotes
 * stripped. Returns undefined when absent or the file has no frontmatter.
 */
export function parseSkillDescription(text: string): string | undefined {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const match = /^description:\s*(.+)$/.exec(line);
    if (match?.[1]) {
      const value = match[1].trim();
      return value.replace(/^["']/, '').replace(/["']$/, '');
    }
  }
  return undefined;
}

/**
 * List skills across the configured roots. Missing roots contribute
 * nothing; entries without SKILL.md are skipped; read failures on a
 * single skill degrade to "no description". Sorted user-scope first,
 * then by name.
 */
export async function listSkills(dirs: SkillsDir[]): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir.path);
    } catch {
      continue; // missing root → contributes nothing
    }
    for (const entry of entries) {
      const skillPath = join(dir.path, entry);
      try {
        const info = await stat(skillPath);
        if (!info.isDirectory()) continue;
        const md = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
        const description = parseSkillDescription(md);
        skills.push({
          name: entry,
          scope: dir.scope,
          path: skillPath,
          ...(description !== undefined && { description }),
        });
      } catch {
        continue; // no SKILL.md (or unreadable) → not a skill
      }
    }
  }
  const scopeRank: Record<SkillScope, number> = { user: 0, project: 1 };
  skills.sort((a, b) => scopeRank[a.scope] - scopeRank[b.scope] || a.name.localeCompare(b.name));
  return skills;
}
