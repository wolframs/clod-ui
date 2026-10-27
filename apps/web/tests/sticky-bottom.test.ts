/**
 * Pure unit tests for the sticky-bottom helpers. No DOM. Hand-crafted
 * ScrollGeometry samples; assertions are purely about the policy.
 *
 * Plan: plans/landed/2026-05-06-clod-ui-pr18d-1-scroll-to-bottom-v1.md
 */

import { describe, expect, test } from 'bun:test';

import {
  STICKY_BOTTOM_THRESHOLD_PX,
  isAtBottom,
  shouldStickToBottom,
  type ScrollGeometry,
} from '@/lib/sticky-bottom';

const G = (scrollTop: number, scrollHeight: number, clientHeight = 500): ScrollGeometry => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('isAtBottom', () => {
  test('exact bottom returns true', () => {
    expect(isAtBottom(G(500, 1000, 500))).toBe(true);
  });

  test('within default threshold returns true', () => {
    // 1000 - (500 - 20 + 500) = 20 <= 24 → at bottom
    expect(isAtBottom(G(480, 1000, 500))).toBe(true);
  });

  test('outside default threshold returns false', () => {
    // 1000 - (400 + 500) = 100 > 24 → not at bottom
    expect(isAtBottom(G(400, 1000, 500))).toBe(false);
  });

  test('respects custom threshold', () => {
    // 1000 - (450 + 500) = 50; >= 50 → at bottom only when threshold ≥ 50
    expect(isAtBottom(G(450, 1000, 500), 50)).toBe(true);
    expect(isAtBottom(G(450, 1000, 500), 49)).toBe(false);
  });

  test('content shorter than viewport is treated as at bottom', () => {
    // scrollHeight === clientHeight (no scroll possible)
    expect(isAtBottom(G(0, 500, 500))).toBe(true);
  });

  test('STICKY_BOTTOM_THRESHOLD_PX is 24', () => {
    // Pinned for spec stability — chat-app convention.
    expect(STICKY_BOTTOM_THRESHOLD_PX).toBe(24);
  });
});

describe('shouldStickToBottom', () => {
  test('content grew + was at bottom → stick', () => {
    expect(shouldStickToBottom(G(500, 1000), G(700, 1200), true)).toBe(true);
  });

  test('content grew but user scrolled away (wasAtBottom=false) → freeze', () => {
    expect(shouldStickToBottom(G(200, 1000), G(200, 1200), false)).toBe(false);
  });

  test('content shrank → no stick (no streaming = no auto-scroll)', () => {
    expect(shouldStickToBottom(G(500, 1000), G(500, 800), true)).toBe(false);
  });

  test('content unchanged → no stick (no event to react to)', () => {
    expect(shouldStickToBottom(G(500, 1000), G(500, 1000), true)).toBe(false);
  });

  test('user at bottom but content unchanged still no stick', () => {
    // No size growth means nothing happened; do not scroll.
    expect(shouldStickToBottom(G(0, 500), G(0, 500), true)).toBe(false);
  });
});
