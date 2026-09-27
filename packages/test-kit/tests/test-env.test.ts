import { existsSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import { TestEnv } from '../src/index.ts';

describe('TestEnv', () => {
  test('creates isolated temp dirs and an ephemeral port', async () => {
    const env = await TestEnv.create({ name: 'iso' });
    try {
      expect(existsSync(env.appDataDir)).toBe(true);
      expect(existsSync(env.fakeClaudeHome)).toBe(true);
      expect(env.port).toBeGreaterThan(0);
      expect(env.root.includes('clod-ui-test')).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  test('dispose removes the root directory', async () => {
    const env = await TestEnv.create();
    const root = env.root;
    await env.dispose();
    expect(existsSync(root)).toBe(false);
  });

  test('two envs have distinct roots and ports', async () => {
    const a = await TestEnv.create();
    const b = await TestEnv.create();
    try {
      expect(a.root).not.toBe(b.root);
      // Ports may rarely coincide if both racingly allocate, but very unlikely.
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
