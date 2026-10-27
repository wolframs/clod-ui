/**
 * Pure tests for `lib/settings-form.ts` (PR #30) — codecs, assembly,
 * and the diff that gates the PUT.
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';

import {
  applyDraft,
  diffSettings,
  draftFromSettings,
  linesToList,
} from '../src/lib/settings-form.ts';

const LOADED: ClaudeSettings = {
  theme: 'dark',
  allowedTools: ['Read', 'Bash(npm run *)'],
  unknown: { customKey: { nested: true } },
};

describe('draftFromSettings / applyDraft round-trip', () => {
  test('round-trips a loaded document unchanged (unknown carried verbatim)', () => {
    const draft = draftFromSettings(LOADED);
    expect(draft).toEqual({
      theme: 'dark',
      model: '',
      allowedToolsText: 'Read\nBash(npm run *)',
      disallowedToolsText: '',
    });
    expect(applyDraft(LOADED, draft)).toEqual(LOADED);
  });

  test('empty fields omit their keys entirely', () => {
    const next = applyDraft(LOADED, {
      theme: '',
      model: '  ',
      allowedToolsText: ' \n ',
      disallowedToolsText: '',
    });
    expect(next).toEqual({ unknown: LOADED.unknown });
  });

  test('edits land on documented keys; unknown is untouched', () => {
    const next = applyDraft(LOADED, {
      theme: 'light',
      model: 'opus',
      allowedToolsText: 'Read',
      disallowedToolsText: 'WebSearch',
    });
    expect(next).toEqual({
      theme: 'light',
      model: 'opus',
      allowedTools: ['Read'],
      disallowedTools: ['WebSearch'],
      unknown: LOADED.unknown,
    });
  });
});

describe('linesToList', () => {
  test('trims and drops blanks', () => {
    expect(linesToList(' Read \n\n Bash(x) \n')).toEqual(['Read', 'Bash(x)']);
    expect(linesToList('')).toEqual([]);
  });
});

describe('diffSettings', () => {
  test('identical documents diff to nothing', () => {
    expect(diffSettings(LOADED, applyDraft(LOADED, draftFromSettings(LOADED)))).toEqual([]);
  });

  test('changed, added, and removed keys each get a row with (unset) rendering', () => {
    const next: ClaudeSettings = {
      theme: 'light',
      model: 'opus',
      unknown: LOADED.unknown,
    };
    expect(diffSettings(LOADED, next)).toEqual([
      { key: 'theme', from: 'dark', to: 'light' },
      { key: 'model', from: '(unset)', to: 'opus' },
      { key: 'allowedTools', from: 'Read, Bash(npm run *)', to: '(unset)' },
    ]);
  });
});
