import type { BackendEvent, ClaudeBackend, HealthStatus, TurnRequest } from '@clod-ui/backend';
import type { ClodError } from '@clod-ui/contracts';

type PendingEvent = Omit<BackendEvent, 'turn_id'>;

class ScriptBuilder {
  private readonly events: PendingEvent[] = [];
  private initialSessionId?: string;
  private finalized = false;

  init(sessionId: string): this {
    this.initialSessionId = sessionId;
    this.events.push({ kind: 'system.init', session_id: sessionId } as PendingEvent);
    return this;
  }

  assistantText(text: string): this {
    this.events.push({ kind: 'assistant.delta', text } as PendingEvent);
    return this;
  }

  assistantComplete(): this {
    this.events.push({ kind: 'assistant.complete' } as PendingEvent);
    return this;
  }

  thinkingText(text: string): this {
    this.events.push({ kind: 'thinking.delta', text } as PendingEvent);
    return this;
  }

  thinkingComplete(): this {
    this.events.push({ kind: 'thinking.complete' } as PendingEvent);
    return this;
  }

  toolUse(name: string, input: unknown, toolUseId = `tu-${this.events.length}`): this {
    this.events.push({ kind: 'tool.use', tool_use_id: toolUseId, name, input } as PendingEvent);
    return this;
  }

  toolResult(content: unknown, toolUseId?: string): this {
    const id = toolUseId ?? this.findLastToolUseId();
    this.events.push({ kind: 'tool.result', tool_use_id: id, content } as PendingEvent);
    return this;
  }

  toolError(message: string, toolUseId?: string): this {
    const id = toolUseId ?? this.findLastToolUseId();
    this.events.push({ kind: 'tool.error', tool_use_id: id, message } as PendingEvent);
    return this;
  }

  result(args: { usage?: { input_tokens?: number; output_tokens?: number } } = {}): this {
    this.events.push({ kind: 'turn.result', ...args } as PendingEvent);
    return this;
  }

  cancelled(escalation: 'sigint' | 'sigterm' | 'sigkill' = 'sigint'): this {
    this.events.push({ kind: 'turn.cancelled', escalation } as PendingEvent);
    return this;
  }

  error(error: ClodError): this {
    this.events.push({ kind: 'turn.error', error } as PendingEvent);
    return this;
  }

  end(): { events: PendingEvent[]; sessionId?: string } {
    this.finalized = true;
    const result: { events: PendingEvent[]; sessionId?: string } = {
      events: [...this.events],
    };
    if (this.initialSessionId !== undefined) {
      result.sessionId = this.initialSessionId;
    }
    return result;
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  private findLastToolUseId(): string {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev && ev.kind === 'tool.use') {
        return (ev as unknown as { tool_use_id: string }).tool_use_id;
      }
    }
    throw new Error('ScriptBuilder: toolResult/toolError called without a prior toolUse');
  }
}

/**
 * Build a programmatic event script. End with `.end()` and pass the result to
 * `ScriptedBackend`.
 */
export function script(): ScriptBuilder {
  return new ScriptBuilder();
}

export interface ScriptedBackendOptions {
  /** Sleep (in FakeClock or real-time ms) between events during replay. Defaults to 0. */
  perEventDelayMs?: number;
  /** Optional fake clock — if provided, delays advance this clock instead of real wall time. */
  clockTick?: (ms: number) => void;
  /** Reported `version()` return. */
  version?: string;
  /** Reported `health()` return. */
  health?: HealthStatus;
}

/**
 * Emits a pre-built event sequence. `cancel()` resolves immediately; a cancelled
 * turn emits no further events from subsequent `startTurn` iterations.
 */
export class ScriptedBackend implements ClaudeBackend {
  private readonly events: PendingEvent[];
  private readonly options: ScriptedBackendOptions;
  private readonly cancelled = new Set<string>();

  constructor(built: { events: PendingEvent[] }, options: ScriptedBackendOptions = {}) {
    this.events = built.events;
    this.options = options;
  }

  async *startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    for (const ev of this.events) {
      if (this.cancelled.has(req.turn_id)) return;
      const delay = this.options.perEventDelayMs ?? 0;
      if (delay > 0) {
        if (this.options.clockTick) {
          this.options.clockTick(delay);
        } else {
          await new Promise<void>((r) => setTimeout(r, delay));
        }
      }
      yield { ...(ev as object), turn_id: req.turn_id } as BackendEvent;
    }
  }

  async cancel(turnId: string): Promise<void> {
    this.cancelled.add(turnId);
  }

  async version(): Promise<string> {
    return this.options.version ?? 'scripted-0.0.0';
  }

  async health(): Promise<HealthStatus> {
    return this.options.health ?? { cli: 'ok', version: 'scripted-0.0.0' };
  }
}
