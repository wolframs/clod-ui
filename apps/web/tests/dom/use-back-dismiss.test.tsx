/**
 * `useBackDismiss` (PR #44): one history entry per open overlay; Back closes
 * it; closing otherwise pops it; a released entry passes to the next overlay.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dropStaleBackEntry, useBackDismiss } from '../../src/lib/use-back-dismiss.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '');
});

describe('useBackDismiss', () => {
  it('opening adds one entry; closing pops it', () => {
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const { rerender } = renderHook(({ open }) => useBackDismiss(open, () => {}), {
      initialProps: { open: false },
    });
    expect(push).not.toHaveBeenCalled();

    rerender({ open: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();

    rerender({ open: false });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('Back calls onClose and does not pop a second time', async () => {
    const onClose = vi.fn();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const { rerender } = renderHook(({ open }) => useBackDismiss(open, onClose), {
      initialProps: { open: true },
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    rerender({ open: false });
    expect(back).not.toHaveBeenCalled();
  });

  it('unmounting while open pops the entry', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const { unmount } = renderHook(() => useBackDismiss(true, () => {}));
    unmount();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('after a reload a leftover entry is dropped, and only a marker is', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    dropStaleBackEntry();
    expect(back).not.toHaveBeenCalled();

    window.history.pushState({ dismiss: true }, '');
    dropStaleBackEntry();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a released entry is not popped, and the next overlay adopts it', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const first = renderHook(({ open }) => useBackDismiss(open, () => {}), {
      initialProps: { open: true },
    });
    const push = vi.spyOn(window.history, 'pushState');

    first.result.current.release();
    first.rerender({ open: false });
    expect(back).not.toHaveBeenCalled();

    renderHook(() => useBackDismiss(true, () => {}));
    expect(push).not.toHaveBeenCalled();
  });
});
