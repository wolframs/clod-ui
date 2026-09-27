import type { BackendEvent, ClaudeBackend, HealthStatus, TurnRequest } from './types.ts';

const MSG = 'NotImplemented: phase 2.x will provide this';

/**
 * Placeholder backend used by PR #1 scaffolding. Every method throws so that
 * any accidental use from production code fails loudly rather than silently
 * succeeding with a degenerate response.
 */
export class NotImplementedBackend implements ClaudeBackend {
  async *startTurn(_req: TurnRequest): AsyncIterable<BackendEvent> {
    throw new Error(MSG);
  }

  async cancel(_turnId: string): Promise<void> {
    throw new Error(MSG);
  }

  async version(): Promise<string> {
    throw new Error(MSG);
  }

  async health(): Promise<HealthStatus> {
    throw new Error(MSG);
  }
}
