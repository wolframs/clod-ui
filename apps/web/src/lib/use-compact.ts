/**
 * `useCompact` — true on a phone-width viewport (below Tailwind's `md`).
 *
 * Sizing belongs in `max-md:` classes. This hook is for what differs in
 * structure (drawer vs. sidebar, composer box vs. form), so a marker such as
 * `settings-open` exists once in the DOM, not twice with one hidden (I-3).
 *
 * Spec: plans/2026-11-01-clod-ui-pr44-mobile-v1.md §1.
 */
import * as React from 'react';

export const COMPACT_QUERY = '(max-width: 767px)';

export function useCompact(): boolean {
  const [compact, setCompact] = React.useState<boolean>(
    () => window.matchMedia(COMPACT_QUERY).matches,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(COMPACT_QUERY);
    const onChange = (ev: MediaQueryListEvent): void => setCompact(ev.matches);
    setCompact(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return compact;
}
