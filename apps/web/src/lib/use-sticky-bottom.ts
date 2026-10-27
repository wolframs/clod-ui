/**
 * useStickyBottom — sticky-bottom auto-scroll for a scroll container.
 *
 * Attached to a scroll container ref + a content-size signal (anything that
 * changes when content grows: messages.length, message text length, turn
 * status, etc.). When the content grows AND the user was at the bottom
 * before the growth, the hook scrolls to the bottom synchronously after
 * the DOM commit. When the user has scrolled away from the bottom, the
 * hook freezes — no auto-scroll until the user returns to the bottom.
 *
 * The pure helpers `isAtBottom` + `shouldStickToBottom` live in
 * `apps/web/src/lib/sticky-bottom.ts` and carry the per-frame measurement
 * + decision logic; the hook is only the React lifecycle wiring.
 *
 * Plan: plans/2026-05-06-clod-ui-pr18d-1-scroll-to-bottom-v1.md.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { isAtBottom, shouldStickToBottom } from './sticky-bottom';

export interface UseStickyBottomOptions {
  /** The element whose scrollTop / scrollHeight / clientHeight we drive. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * A signal that changes whenever the renderable content changes size.
   * Typically a JSON.stringify or a structural digest. The hook only
   * compares prev !== next; it does not interpret the value.
   */
  contentSignal: unknown;
  /**
   * Pixel threshold for "at the bottom". Default 24 (~ 1.5 lines).
   * See sticky-bottom.ts: STICKY_BOTTOM_THRESHOLD_PX.
   */
  thresholdPx?: number;
  /**
   * When true, render-driven scroll uses element.scrollTo({ behavior: 'smooth' }).
   * When false (default), uses an instant assignment to scrollTop. Smooth
   * looks nicer for low-frequency events but stutters during fast streaming;
   * the default is instant so the user never sees a lagging cursor.
   */
  smooth?: boolean;
}

export interface UseStickyBottomReturn {
  /** True iff the container is currently at the bottom (within threshold). */
  isAtBottom: boolean;
  /** Imperative escape: scroll to bottom now (e.g. clicking a "jump to latest" button). */
  scrollToBottom: () => void;
}

/**
 * Sticky-bottom auto-scroll. See module header for behavior.
 */
export function useStickyBottom(opts: UseStickyBottomOptions): UseStickyBottomReturn {
  const { containerRef, contentSignal, thresholdPx, smooth = false } = opts;

  // Track "was at bottom before this commit" — measured before the DOM updates.
  const wasAtBottomRef = useRef<boolean>(true);
  // Previous content signal so we can detect changes without re-rendering on every contentSignal change.
  const prevSignalRef = useRef<unknown>(contentSignal);
  // Previous scrollHeight so the helper can detect grew/shrank/unchanged.
  const prevScrollHeightRef = useRef<number>(0);

  // Public state for "is the user currently at the bottom?". Updated on scroll events.
  const [atBottom, setAtBottom] = useState<boolean>(true);

  // Measure container BEFORE DOM commits (so wasAtBottomRef captures the
  // pre-update state). useLayoutEffect runs synchronously after render but
  // before paint, which is the right phase: React has already updated the
  // DOM, but the measurements still reflect this commit.
  //
  // For the wasAtBottom snapshot we actually need the PREVIOUS commit's
  // bottom-ness. We capture it on every scroll event into wasAtBottomRef
  // and then read it here.

  // Effect fires when contentSignal changes. Decide whether to stick.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const prevScrollHeight = prevScrollHeightRef.current;
    const nextScrollHeight = el.scrollHeight;
    const wasAtBottom = wasAtBottomRef.current;

    const stick = shouldStickToBottom(
      { scrollTop: el.scrollTop, scrollHeight: prevScrollHeight, clientHeight: el.clientHeight },
      { scrollTop: el.scrollTop, scrollHeight: nextScrollHeight, clientHeight: el.clientHeight },
      wasAtBottom,
    );

    if (stick) {
      // Max scrollable position is (scrollHeight - clientHeight); using
      // scrollHeight directly relies on browsers clamping silently. Be
      // explicit so the behavior is identical across runtimes (real
      // browsers AND headless DOM impls used in tests).
      const target = el.scrollHeight - el.clientHeight;
      if (smooth && typeof el.scrollTo === 'function') {
        el.scrollTo({ top: target, behavior: 'smooth' });
      } else {
        el.scrollTop = target;
      }
    }

    prevScrollHeightRef.current = nextScrollHeight;
    prevSignalRef.current = contentSignal;
    // Re-measure after potential scroll: we ARE at the bottom if we just stuck;
    // otherwise it's whatever the user's scroll position implied.
    wasAtBottomRef.current = isAtBottom(el, thresholdPx);
    setAtBottom(wasAtBottomRef.current);
  }, [contentSignal, containerRef, smooth, thresholdPx]);

  // Track scroll events to capture wasAtBottom before the next contentSignal change.
  //
  // `contentSignal` is deliberately in the deps: `containerRef` is a stable
  // ref object, so without it this effect runs exactly once — and if the
  // container mounts *later* (App renders the conversation pane only once a
  // conversation is selected), the listener would never attach. Re-running on
  // every signal change re-attaches cheaply and is guaranteed to fire after
  // the pane mounts, because mounting always transitions the transcript
  // status (idle → loading → …) which is part of the signal upstream.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = (): void => {
      const at = isAtBottom(el, thresholdPx);
      wasAtBottomRef.current = at;
      setAtBottom(at);
    };

    // Initial measurement.
    handleScroll();
    prevScrollHeightRef.current = el.scrollHeight;

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef, thresholdPx, contentSignal]);

  const scrollToBottom = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    if (smooth && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      el.scrollTop = target;
    }
    wasAtBottomRef.current = true;
    setAtBottom(true);
  };

  return { isAtBottom: atBottom, scrollToBottom };
}
