/**
 * `useConversationRoute` — the selected conversation, kept in the URL hash
 * (`#/c/<conv_id>`). A reload comes back to the same conversation and the
 * browser's Back goes to the previous one. No router: one id is all the
 * location holds.
 *
 * Spec: plans/2026-11-01-clod-ui-pr44-mobile-v1.md §2.
 */
import * as React from 'react';

const HASH_PREFIX = '#/c/';
const CONV_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The conversation a location hash names, or undefined. */
export function parseConversationHash(hash: string): string | undefined {
  if (!hash.startsWith(HASH_PREFIX)) return undefined;
  const id = hash.slice(HASH_PREFIX.length);
  return CONV_ID.test(id) ? id : undefined;
}

export function conversationHash(convId: string): string {
  return `${HASH_PREFIX}${convId}`;
}

export interface SelectOptions {
  /** Overwrite the current history entry instead of adding one. */
  replace?: boolean;
}

export interface ConversationRoute {
  selectedId: string | undefined;
  select: (convId: string, opts?: SelectOptions) => void;
}

export function useConversationRoute(): ConversationRoute {
  const [selectedId, setSelectedId] = React.useState<string | undefined>(() =>
    parseConversationHash(window.location.hash),
  );

  React.useEffect(() => {
    const onPop = (): void => setSelectedId(parseConversationHash(window.location.hash));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = React.useCallback((convId: string, opts?: SelectOptions): void => {
    const hash = conversationHash(convId);
    if (opts?.replace === true) window.history.replaceState(null, '', hash);
    else if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    setSelectedId(convId);
  }, []);

  return { selectedId, select };
}
