type ScheduledTask = {
  id: number;
  dueAt: number;
  interval?: number;
  fn: () => void;
};

/**
 * Per-TestEnv deterministic clock. Never installed globally.
 * `setTimeout`/`setInterval` replacements return numeric handles; `clearTimeout`
 * and `clearInterval` accept those handles and no-op otherwise.
 *
 * Spec: plans/2026-04-23-clod-ui-test-strategy-v1.md risk §2 (clock hermeticity).
 */
export class FakeClock {
  private current = 0;
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  now(): number {
    return this.current;
  }

  tick(ms: number): void {
    if (ms < 0) throw new Error('FakeClock.tick: negative delta');
    const target = this.current + ms;
    // Process tasks in due-order, re-sorting after each fire to catch intervals.
    while (true) {
      this.tasks.sort((a, b) => a.dueAt - b.dueAt);
      const head = this.tasks[0];
      if (!head || head.dueAt > target) break;
      this.current = head.dueAt;
      // Drop the task first; intervals re-enqueue after firing so they respect cancellation.
      this.tasks.shift();
      try {
        head.fn();
      } catch (err) {
        // Swallow so one bad timer doesn't halt the clock; surface via console for debugging.
        console.error('[FakeClock] task threw', err);
      }
      if (head.interval != null) {
        this.tasks.push({
          id: head.id,
          dueAt: this.current + head.interval,
          interval: head.interval,
          fn: head.fn,
        });
      }
    }
    this.current = target;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.push({ id, dueAt: this.current + ms, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.push({ id, dueAt: this.current + ms, interval: ms, fn });
    return id;
  }

  clearInterval(id: number): void {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }
}

/**
 * Registry for modules that opt-in to a per-env clock. In PR #1 this is an
 * empty shell — Phase 2 modules call `registerClockAware` and read `.clock`.
 */
export function installFakeClock(_env: { clock: FakeClock }): void {
  // intentionally empty in PR #1
}
