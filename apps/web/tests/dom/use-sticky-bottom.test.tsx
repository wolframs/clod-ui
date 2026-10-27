/**
 * useStickyBottom — DOM-tier integration tests.
 *
 * Drives a real (happy-dom) scroll container; manipulates scrollTop +
 * scrollHeight + clientHeight directly to simulate user scroll behavior;
 * asserts the hook's auto-scroll + isAtBottom contract.
 *
 * Plan: plans/2026-05-06-clod-ui-pr18d-1-scroll-to-bottom-v1.md
 */

import { renderHook, act } from '@testing-library/react';
import { type RefObject } from 'react';
import { describe, expect, test, beforeEach } from 'vitest';

import { useStickyBottom } from '../../src/lib/use-sticky-bottom';

type ContainerEl = HTMLElement & { _scrollHeight?: number; _clientHeight?: number };

function makeContainer(scrollHeight: number, clientHeight: number): ContainerEl {
  const el = document.createElement('div') as ContainerEl;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => el._scrollHeight ?? scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => el._clientHeight ?? clientHeight,
  });
  el._scrollHeight = scrollHeight;
  el._clientHeight = clientHeight;
  el.scrollTop = scrollHeight - clientHeight;
  document.body.appendChild(el);
  return el;
}

function setScrollHeight(el: ContainerEl, h: number): void {
  el._scrollHeight = h;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('useStickyBottom', () => {
  test('starts at bottom when container is fresh', () => {
    const el = makeContainer(1000, 600);
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result } = renderHook(() => useStickyBottom({ containerRef: ref, contentSignal: 0 }));
    expect(result.current.isAtBottom).toBe(true);
  });

  test('content growth while at bottom auto-scrolls to new bottom', () => {
    const el = makeContainer(1000, 600);
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { rerender } = renderHook(
      ({ signal }: { signal: number }) =>
        useStickyBottom({ containerRef: ref, contentSignal: signal }),
      { initialProps: { signal: 0 } },
    );
    // Sanity: scrollTop is at the initial bottom.
    expect(el.scrollTop).toBe(400);

    // Content grows by 200px; signal changes.
    setScrollHeight(el, 1200);
    rerender({ signal: 1 });

    // Hook should have stuck to the new bottom: scrollTop = 1200 - 600 = 600.
    expect(el.scrollTop).toBe(600);
  });

  test('content growth while user scrolled away does NOT auto-scroll', () => {
    const el = makeContainer(1000, 600);
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { rerender } = renderHook(
      ({ signal }: { signal: number }) =>
        useStickyBottom({ containerRef: ref, contentSignal: signal }),
      { initialProps: { signal: 0 } },
    );

    // User scrolls to 100 (far from bottom).
    act(() => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
    });

    setScrollHeight(el, 1500);
    rerender({ signal: 1 });

    // scrollTop should NOT have moved.
    expect(el.scrollTop).toBe(100);
  });

  test('isAtBottom flips to false when user scrolls up', () => {
    const el = makeContainer(1000, 600);
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result } = renderHook(() => useStickyBottom({ containerRef: ref, contentSignal: 0 }));
    expect(result.current.isAtBottom).toBe(true);

    act(() => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
    });

    expect(result.current.isAtBottom).toBe(false);
  });

  test('scrollToBottom() jumps to bottom and re-engages stickiness', () => {
    const el = makeContainer(1000, 600);
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result, rerender } = renderHook(
      ({ signal }: { signal: number }) =>
        useStickyBottom({ containerRef: ref, contentSignal: signal }),
      { initialProps: { signal: 0 } },
    );

    // Scroll away, freeze.
    act(() => {
      el.scrollTop = 50;
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    // Imperative jump.
    act(() => {
      result.current.scrollToBottom();
    });
    expect(el.scrollTop).toBe(400);
    expect(result.current.isAtBottom).toBe(true);

    // Content grows after the jump — stickiness was re-engaged, so the hook
    // should follow to the new bottom: 1300 - 600 = 700.
    setScrollHeight(el, 1300);
    rerender({ signal: 1 });
    expect(el.scrollTop).toBe(700);
  });

  test('attaches to a container that mounts after the hook (late ref + signal change)', () => {
    // App.tsx renders the conversation pane only once a conversation is
    // selected — the ref is null on first render and points at a real
    // element later. The scroll listener must still attach (it re-runs on
    // contentSignal changes, which mounting always produces upstream).
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { result, rerender } = renderHook(
      ({ signal }: { signal: number }) =>
        useStickyBottom({ containerRef: ref, contentSignal: signal }),
      { initialProps: { signal: 0 } },
    );

    const el = makeContainer(1000, 600);
    ref.current = el;
    rerender({ signal: 1 });

    // Listener is live: scrolling away is observed.
    act(() => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    // And growth while away does not auto-scroll.
    setScrollHeight(el, 1500);
    rerender({ signal: 2 });
    expect(el.scrollTop).toBe(100);
  });

  test('handles missing ref gracefully (no throw)', () => {
    const ref: RefObject<HTMLElement | null> = { current: null };
    expect(() => {
      renderHook(() => useStickyBottom({ containerRef: ref, contentSignal: 0 }));
    }).not.toThrow();
  });
});
