/**
 * T1.02 — Resume re-passes flags and uses `--resume`.
 *
 * Contract: sending a second turn on the same conversation produces argv
 * containing `--resume <session_id>` plus every per-conversation setting
 * (model, tool allowlist, system-prompt mode). Verified against the pure
 * flag composer.
 *
 * PR #3 un-skips this test against the composer. A later PR layers a
 * `TapeBackend` assertion on top to cross-check against real CLI behavior.
 */
import { compose } from '@clod-ui/backend';
import type { TurnRequest } from '@clod-ui/backend';
import { describe, expect, test } from 'bun:test';

describe('T1.02 resume passes flags', () => {
  test('second turn argv contains --resume and persisted settings', () => {
    const req: TurnRequest = {
      turn_id: 'turn-2',
      conv_id: 'conv-1',
      resume_session_id: 'sess-x',
      user_message: 'continue please',
      model: 'sonnet',
      system_prompt: { mode: 'append', text: 'be concise' },
      allowed_tools: ['Read', 'Edit'],
      cwd: '/tmp/conv-1/cwd',
    };
    const { argv } = compose(req);

    // Each flag exists, with its value in the adjacent slot.
    const pairs: Array<[string, string | string[]]> = [
      ['--resume', 'sess-x'],
      ['--model', 'sonnet'],
      ['--append-system-prompt', 'be concise'],
      ['--allowedTools', ['Read', 'Edit']],
    ];
    for (const [flag, value] of pairs) {
      const idx = argv.indexOf(flag);
      expect(idx).toBeGreaterThan(-1);
      if (Array.isArray(value)) {
        expect(argv.slice(idx + 1, idx + 1 + value.length)).toEqual(value);
      } else {
        expect(argv[idx + 1]).toBe(value);
      }
    }
  });
});
