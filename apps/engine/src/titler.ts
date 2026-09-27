/**
 * Auto-titling: pluggable Titler interface + a deterministic fallback impl.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.5
 * IMPL: plans/landed/2026-04-25-clod-ui-pr10-auto-titling-v1.md
 *
 * The interface is shaped so a future `DefaultTitler` (PR #11) can spawn
 * `claude -p`, apply a budget, and delegate to `FallbackTitler` on failure
 * — all behind the same `suggestTitle` contract. The engine's wiring is
 * agnostic to which titler is plugged in.
 */

/** Wire envelope payload for the `conversation.titled` wire-event kind. */
export interface ConversationTitledEvent {
  kind: 'conversation.titled';
  conv_id: string;
  title: string;
}

export interface TitlerInput {
  conv_id: string;
  /** The user message that started this turn. May be the empty string. */
  user_message: string;
  /** Accumulated assistant text from the just-finished turn. May be empty. */
  assistant_text: string;
  /** Wall-clock timestamp of the terminator event. Used by the fallback. */
  ts: number;
}

export interface Titler {
  /**
   * Always returns a non-empty string. Implementations are responsible for
   * their own internal failure handling — callers never have to deal with
   * a thrown titler error.
   */
  suggestTitle(input: TitlerInput): Promise<string>;
}

/**
 * Maximum number of words taken from the first sentence. Calibrated against
 * a typical sidebar's horizontal real estate; the UI will further truncate
 * visually if needed.
 */
const MAX_WORDS = 8;
/** Per-word character cap, defending against pathological mega-tokens. */
const MAX_WORD_CHARS = 24;
/** Joined-string cap. The manifest doesn't enforce this; the UI doesn't either. */
const MAX_TITLE_CHARS = 80;

/**
 * Derive a title from `(user_message, ts)` deterministically. No I/O, no async.
 *
 * Algorithm (see plan §FallbackTitler derivation rule):
 *   1. Trim user_message.
 *   2. Take the first sentence (split on `.`, `!`, `?`, newline).
 *   3. Take the first MAX_WORDS words; cap each word at MAX_WORD_CHARS.
 *   4. Cap the joined string at MAX_TITLE_CHARS.
 *   5. If the result is empty, return `Conversation @ <YYYY-MM-DD HH:MM>`.
 */
export function fallbackFirstWordsTitle(input: TitlerInput): string {
  const trimmed = input.user_message.trim();
  if (trimmed.length > 0) {
    // First-sentence split: the *earliest* of `.`, `!`, `?`, `\n`.
    let sentenceEnd = trimmed.length;
    for (const ch of ['.', '!', '?', '\n']) {
      const idx = trimmed.indexOf(ch);
      if (idx >= 0 && idx < sentenceEnd) sentenceEnd = idx;
    }
    const firstSentence = trimmed.slice(0, sentenceEnd).trim();
    if (firstSentence.length > 0) {
      const words = firstSentence.split(/\s+/).filter((w) => w.length > 0);
      const capped = words.slice(0, MAX_WORDS).map((w) => {
        return w.length > MAX_WORD_CHARS ? w.slice(0, MAX_WORD_CHARS) : w;
      });
      const joined = capped.join(' ');
      const finalTitle =
        joined.length > MAX_TITLE_CHARS ? joined.slice(0, MAX_TITLE_CHARS).trimEnd() : joined;
      if (finalTitle.length > 0) return finalTitle;
    }
  }
  return dateStampedTitle(input.ts);
}

/** Format a `ts` (ms since epoch) as `Conversation @ YYYY-MM-DD HH:MM` (UTC). */
function dateStampedTitle(ts: number): string {
  const d = new Date(ts);
  // Use UTC so the title is stable across machines / timezones for the same
  // wall-clock value. UI is free to render localized but the manifest carries
  // the canonical UTC string.
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  return `Conversation @ ${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Pure-function titler: returns the deterministic fallback title every time.
 * Used as the default until PR #11 swaps in `DefaultTitler` (which itself
 * delegates here on `claude -p` failure / timeout / empty).
 */
export class FallbackTitler implements Titler {
  async suggestTitle(input: TitlerInput): Promise<string> {
    return fallbackFirstWordsTitle(input);
  }
}
