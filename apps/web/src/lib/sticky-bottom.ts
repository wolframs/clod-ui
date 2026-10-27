/**
 * Pure helpers for the sticky-bottom auto-scroll behaviour. The hook in
 * apps/web/src/lib/use-sticky-bottom.ts wraps these against a real scroll
 * container; tests for the pure helpers live in
 * apps/web/tests/sticky-bottom.test.ts and assert the policy without DOM.
 *
 * Plan: plans/landed/2026-05-06-clod-ui-pr18d-1-scroll-to-bottom-v1.md
 */

/**
 * Geometry of a scroll container at one moment in time. All three numbers
 * come straight from the `Element` API (scrollTop / scrollHeight /
 * clientHeight) — no jQuery, no library, no synthetic adapter. Captured as
 * a typed shape so the helpers can be tested with hand-crafted samples.
 */
export interface ScrollGeometry {
  /** Distance from top of content to top of viewport, in CSS pixels. */
  scrollTop: number;
  /** Total scrollable content height, in CSS pixels. */
  scrollHeight: number;
  /** Visible viewport height, in CSS pixels. */
  clientHeight: number;
}

/**
 * Pixel slack at the bottom for the "user is at the bottom" predicate.
 * 24px ~ one line of text + breathing room; typical chat-app convention.
 */
export const STICKY_BOTTOM_THRESHOLD_PX = 24;

/**
 * True when the viewport's bottom edge is within
 * STICKY_BOTTOM_THRESHOLD_PX of the content's bottom.
 *
 * Why a threshold rather than exact equality: subpixel rounding under
 * fractional zoom + browser quirks make `scrollTop + clientHeight ===
 * scrollHeight` unreliable. The threshold is the established chat-app
 * convention (Discord / Slack / iMessage all use a similar slack value).
 */
export function isAtBottom(g: ScrollGeometry, threshold = STICKY_BOTTOM_THRESHOLD_PX): boolean {
  return g.scrollHeight - (g.scrollTop + g.clientHeight) <= threshold;
}

/**
 * Decide whether to programmatically scroll to the bottom on a content-
 * size increase. Pure function so the hook can stay thin.
 *
 *   prev:    geometry observed before the content grew
 *   next:    geometry observed after the content grew
 *   wasAtBottom: whether the user was at the bottom *before* the growth
 *
 * Returns true iff:
 *   - content actually grew (next.scrollHeight > prev.scrollHeight), AND
 *   - the user was at the bottom before the growth.
 *
 * The "wasAtBottom before growth" predicate is what gives the user
 * scroll-up freezing for free: if they scrolled away during streaming,
 * wasAtBottom is false and this returns false until they scroll back.
 */
export function shouldStickToBottom(
  prev: ScrollGeometry,
  next: ScrollGeometry,
  wasAtBottom: boolean,
): boolean {
  if (!wasAtBottom) return false;
  return next.scrollHeight > prev.scrollHeight;
}
