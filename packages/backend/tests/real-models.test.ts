import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { RealClaudeBackend } from '../src/real.ts';

/**
 * PR #42: `listModels` against a shim that answers the stream-json
 * `initialize` control request the way CLI 2.1.310 does.
 */
let dir: string;
let log: string;

function writeShim(reply: 'ok' | 'error' | 'silent'): string {
  const shim = join(dir, 'claude');
  const body =
    reply === 'ok'
      ? `printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"models":[{"value":"opus","displayName":"Opus 5.5","resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","max"]}]}}}\\n' "$id"`
      : reply === 'error'
        ? `printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"not logged in"}}\\n' "$id"`
        : 'sleep 30';
  writeFileSync(
    shim,
    [
      '#!/usr/bin/env bash',
      'if [[ "${1:-}" == "--version" ]]; then echo "2.1.310 (Claude Code)"; exit 0; fi',
      `echo "$$ $*" >> ${JSON.stringify(log)}`,
      'IFS= read -r line',
      `id=$(printf '%s' "$line" | sed -E 's/.*"request_id":"([^"]*)".*/\\1/')`,
      body,
      'read -r _ || true',
    ].join('\n') + '\n',
  );
  chmodSync(shim, 0o755);
  return shim;
}

function spawnLines(): string[] {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clod-ui-models-'));
  log = join(dir, 'spawns.log');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function backend(shim: string): Promise<RealClaudeBackend> {
  const be = new RealClaudeBackend({ claudeBinary: shim });
  await (be as unknown as { refresh(): Promise<void> }).refresh();
  return be;
}

describe('RealClaudeBackend.listModels', () => {
  test('one probe with hooks disabled serves concurrent callers, then the cache', async () => {
    const be = await backend(writeShim('ok'));
    try {
      const [a, b] = await Promise.all([be.listModels({ cwd: dir }), be.listModels()]);
      expect(a).toEqual([
        {
          value: 'opus',
          display_name: 'Opus 5.5',
          resolved_model: 'claude-opus-5-5',
          effort_levels: ['low', 'max'],
        },
      ]);
      expect(b).toBe(a);
      await be.listModels();
      expect(spawnLines()).toHaveLength(1);
      expect(spawnLines()[0]).toContain('--settings {"disableAllHooks":true}');
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('an error reply rejects with the CLI message and is not cached', async () => {
    const be = await backend(writeShim('error'));
    try {
      await expect(be.listModels()).rejects.toThrow('not logged in');
      await expect(be.listModels()).rejects.toThrow('not logged in');
      expect(spawnLines()).toHaveLength(2);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('the probe process is gone after the reply', async () => {
    const be = await backend(writeShim('ok'));
    try {
      await be.listModels();
      const pid = Number(spawnLines()[0]!.split(' ')[0]);
      const deadline = Date.now() + 3000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(25);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await be.stop();
    }
  }, 15_000);
});
