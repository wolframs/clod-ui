import { describe, expect, test } from 'bun:test';

import { conversationHash, parseConversationHash } from '../src/lib/use-conversation-route.ts';

describe('conversation route', () => {
  test('a conversation id survives the round trip', () => {
    const id = '82edc84a-29cb-4789-8897-93fea90ab8a1';
    expect(parseConversationHash(conversationHash(id))).toBe(id);
  });

  test.each(['', '#', '#/c/', '#/x/abc', '#/c/../etc', '#/c/a b', `#/c/${'a'.repeat(65)}`])(
    '%p names no conversation',
    (hash) => {
      expect(parseConversationHash(hash)).toBeUndefined();
    },
  );
});
