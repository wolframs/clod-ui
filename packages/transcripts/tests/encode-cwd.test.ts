import { describe, expect, test } from 'bun:test';

import { encodeCwd } from '../src/index.ts';

describe('encodeCwd', () => {
  test.each([
    ['/Users/example/Projects/clod-ui', '-Users-example-Projects-clod-ui'],
    ['/a/b/c', '-a-b-c'],
    ['/', '-'],
    ['', ''],
    ['/tmp/clod-ui-test/x', '-tmp-clod-ui-test-x'],
    ['no-leading-slash/x', 'no-leading-slash-x'],
  ])('encodes %p to %p', (input, expected) => {
    expect(encodeCwd(input)).toBe(expected);
  });
});
