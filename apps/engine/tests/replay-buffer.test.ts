/**
 * Unit tests for `ReplayBuffer`.
 *
 * Coverage: capacity validation, FIFO eviction, since(null) snapshot,
 * since(latest) empty, since(somewhere-inside) returns suffix, since(older-
 * than-oldest) returns full buffer with gap=true, since(empty buffer)
 * returns empty no-gap, ordering preserved.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §9.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';

import { ReplayBuffer } from '../src/replay-buffer.ts';

function env(id: string, kind = 'assistant.delta'): EventEnvelope {
  return {
    v: 1,
    id,
    ts: 1000,
    kind,
    payload: { kind, text: 'x' },
  };
}

// EnvelopeIdSource format mirror: 12-char zero-padded hex counter at the
// tail of a fixed UUID prefix. Lex order matches numeric order.
function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

describe('ReplayBuffer — construction', () => {
  test('default capacity is 1024', () => {
    const buf = new ReplayBuffer();
    expect(buf.capacity()).toBe(1024);
  });

  test('explicit capacity is honored', () => {
    const buf = new ReplayBuffer({ capacity: 4 });
    expect(buf.capacity()).toBe(4);
  });

  test('rejects non-positive capacity', () => {
    expect(() => new ReplayBuffer({ capacity: 0 })).toThrow();
    expect(() => new ReplayBuffer({ capacity: -1 })).toThrow();
    expect(() => new ReplayBuffer({ capacity: 1.5 })).toThrow();
  });
});

describe('ReplayBuffer — push + size', () => {
  test('size grows with each push under capacity', () => {
    const buf = new ReplayBuffer({ capacity: 4 });
    expect(buf.size()).toBe(0);
    buf.push(env(id(1)));
    expect(buf.size()).toBe(1);
    buf.push(env(id(2)));
    expect(buf.size()).toBe(2);
  });

  test('size caps at capacity (FIFO eviction)', () => {
    const buf = new ReplayBuffer({ capacity: 3 });
    for (let n = 1; n <= 10; n++) buf.push(env(id(n)));
    expect(buf.size()).toBe(3);
  });

  test('FIFO eviction drops the oldest entry first', () => {
    const buf = new ReplayBuffer({ capacity: 3 });
    for (let n = 1; n <= 5; n++) buf.push(env(id(n)));
    // Should retain only the last 3 (3, 4, 5).
    const result = buf.since(null);
    expect(result.envelopes.map((e) => e.id)).toEqual([id(3), id(4), id(5)]);
  });
});

describe('ReplayBuffer — since(null)', () => {
  test('on empty buffer returns empty no-gap', () => {
    const buf = new ReplayBuffer({ capacity: 4 });
    const r = buf.since(null);
    expect(r.envelopes).toEqual([]);
    expect(r.gap).toBe(false);
  });

  test('returns full snapshot, ordering preserved', () => {
    const buf = new ReplayBuffer({ capacity: 4 });
    buf.push(env(id(1)));
    buf.push(env(id(2)));
    buf.push(env(id(3)));
    const r = buf.since(null);
    expect(r.envelopes.map((e) => e.id)).toEqual([id(1), id(2), id(3)]);
    expect(r.gap).toBe(false);
  });
});

describe('ReplayBuffer — since(<id>)', () => {
  test('id at-or-beyond newest returns empty no-gap', () => {
    const buf = new ReplayBuffer({ capacity: 4 });
    buf.push(env(id(1)));
    buf.push(env(id(2)));
    const r = buf.since(id(2));
    expect(r.envelopes).toEqual([]);
    expect(r.gap).toBe(false);
  });

  test('id strictly older than newest returns the suffix', () => {
    const buf = new ReplayBuffer({ capacity: 8 });
    for (let n = 1; n <= 5; n++) buf.push(env(id(n)));
    const r = buf.since(id(3));
    expect(r.envelopes.map((e) => e.id)).toEqual([id(4), id(5)]);
    expect(r.gap).toBe(false);
  });

  test('id matching oldest returns suffix (oldest itself excluded)', () => {
    const buf = new ReplayBuffer({ capacity: 8 });
    for (let n = 1; n <= 4; n++) buf.push(env(id(n)));
    const r = buf.since(id(1));
    expect(r.envelopes.map((e) => e.id)).toEqual([id(2), id(3), id(4)]);
    expect(r.gap).toBe(false);
  });

  test('id older than oldest buffered returns full buffer with gap=true', () => {
    const buf = new ReplayBuffer({ capacity: 3 });
    for (let n = 100; n <= 105; n++) buf.push(env(id(n))); // evicts 100,101,102
    const r = buf.since(id(50));
    expect(r.envelopes.map((e) => e.id)).toEqual([id(103), id(104), id(105)]);
    expect(r.gap).toBe(true);
  });

  test('id query against empty buffer returns empty no-gap', () => {
    const buf = new ReplayBuffer({ capacity: 4 });
    const r = buf.since(id(99));
    expect(r.envelopes).toEqual([]);
    expect(r.gap).toBe(false);
  });
});
