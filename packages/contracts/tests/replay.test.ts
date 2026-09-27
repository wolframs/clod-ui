/**
 * Unit tests for the `replay.start` payload schema and constants.
 *
 * The schema and sentinel id live in `@clod-ui/contracts/replay.ts` as the
 * single source of truth (engine + transport import them from here). These
 * tests pin the wire shape against accidental drift.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-1-replay-schema-and-reconnect-integration-v1.md §3.
 */
import { describe, expect, test } from 'bun:test';

import {
  REPLAY_START_KIND,
  REPLAY_START_SENTINEL_ID,
  ReplayStartPayloadSchema,
} from '../src/replay.ts';

describe('replay.start sentinel + kind constants', () => {
  test('REPLAY_START_KIND is the documented literal', () => {
    expect(REPLAY_START_KIND).toBe('replay.start');
  });

  test('REPLAY_START_SENTINEL_ID is a valid uuid and lex-less than counter=1', () => {
    expect(REPLAY_START_SENTINEL_ID).toBe('00000000-0000-4000-8000-000000000000');
    // Engine's EnvelopeIdSource starts at counter=1 → tail '...000000000001'.
    // Sentinel must lex-precede every real id so it can never match `since`
    // comparisons.
    const firstReal = '00000000-0000-4000-8000-000000000001';
    expect(REPLAY_START_SENTINEL_ID < firstReal).toBe(true);
  });
});

describe('ReplayStartPayloadSchema', () => {
  test('accepts a fully-populated valid payload', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: '11111111-1111-4111-8111-111111111111',
      replayed_count: 12,
      gap: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.since).toBe('11111111-1111-4111-8111-111111111111');
      expect(result.data.replayed_count).toBe(12);
      expect(result.data.gap).toBe(false);
    }
  });

  test('accepts since: null (fresh subscriber, no cursor)', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: null,
      replayed_count: 0,
      gap: false,
    });
    expect(result.success).toBe(true);
  });

  test('accepts gap: true (cursor older than buffer oldest)', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: '00000000-0000-4000-8000-000000000001',
      replayed_count: 1024,
      gap: true,
    });
    expect(result.success).toBe(true);
  });

  test('rejects wrong kind literal', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.end',
      since: null,
      replayed_count: 0,
      gap: false,
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-uuid since', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: 'not-a-uuid',
      replayed_count: 0,
      gap: false,
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative replayed_count', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: null,
      replayed_count: -1,
      gap: false,
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer replayed_count', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: null,
      replayed_count: 1.5,
      gap: false,
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing gap field', () => {
    const result = ReplayStartPayloadSchema.safeParse({
      kind: 'replay.start',
      since: null,
      replayed_count: 0,
    });
    expect(result.success).toBe(false);
  });
});
