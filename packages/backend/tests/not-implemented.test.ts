import { describe, expect, test } from 'bun:test';

import { NotImplementedBackend } from '../src/index.ts';

const dummyTurn = {
  turn_id: 't1',
  conv_id: 'c1',
  user_message: 'hi',
  cwd: '/tmp/does-not-matter',
};

describe('NotImplementedBackend', () => {
  test('startTurn throws on first iteration', async () => {
    const be = new NotImplementedBackend();
    const iter = be.startTurn(dummyTurn)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/NotImplemented/);
  });

  test('cancel rejects', async () => {
    const be = new NotImplementedBackend();
    await expect(be.cancel('t1')).rejects.toThrow(/NotImplemented/);
  });

  test('version rejects', async () => {
    const be = new NotImplementedBackend();
    await expect(be.version()).rejects.toThrow(/NotImplemented/);
  });

  test('health rejects', async () => {
    const be = new NotImplementedBackend();
    await expect(be.health()).rejects.toThrow(/NotImplemented/);
  });
});
