import type { ClaudeBackend, BackendEvent } from '@clod-ui/backend';
import type { EventEnvelope, HealthResponse } from '@clod-ui/contracts';
import { Hono } from 'hono';

/**
 * Minimal wire-surface facade over a ClaudeBackend. Lives in test-kit forever;
 * the production `apps/engine` reimplements the same surface. Used by the
 * typed test client so spine tests consume the contract, not internals.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr1-foundation-v2.md Task 6.8.
 */
export interface MockEngineServerOptions {
  backend: ClaudeBackend;
  engineVersion?: string;
}

export class MockEngineServer {
  private readonly options: MockEngineServerOptions;
  private readonly startedAt = Date.now();
  private readonly envelopeIds = new EnvelopeIdSource();
  private server: ReturnType<typeof Bun.serve> | undefined;
  private sockets = new Set<WebSocket>();

  constructor(options: MockEngineServerOptions) {
    this.options = options;
  }

  async start(port = 0): Promise<{ port: number; url: string }> {
    const app = new Hono();

    app.get('/health', async (c) => {
      const h = await this.options.backend.health();
      const body: HealthResponse = {
        cli: h.cli,
        ...(h.version !== undefined ? { version: h.version } : {}),
        engine_version: this.options.engineVersion ?? '0.0.0-mock',
        started_at: this.startedAt,
      };
      return c.json(body);
    });

    app.post('/conversations/:id/turns', async (c) => {
      const id = c.req.param('id');
      const body = (await c.req.json()) as {
        turn_id: string;
        user_message: string;
        model?: string;
        cwd?: string;
      };
      const req = {
        turn_id: body.turn_id,
        conv_id: id,
        user_message: body.user_message,
        cwd: body.cwd ?? process.cwd(),
        ...(body.model !== undefined ? { model: body.model } : {}),
      };
      // Fire-and-forget stream into connected sockets
      void this.streamTurn(req, id);
      return c.json({ accepted: true });
    });

    app.post('/conversations/:id/cancel', async (c) => {
      const body = (await c.req.json()) as { turn_id: string };
      await this.options.backend.cancel(body.turn_id);
      return c.json({ accepted: true });
    });

    this.server = Bun.serve({
      port,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
          const upgraded = server.upgrade(req, { data: {} });
          if (upgraded) return undefined;
          return new Response('upgrade failed', { status: 400 });
        }
        return app.fetch(req);
      },
      websocket: {
        open: (ws) => {
          this.sockets.add(ws as unknown as WebSocket);
        },
        close: (ws) => {
          this.sockets.delete(ws as unknown as WebSocket);
        },
        message: () => {
          // Mock server does not accept client-initiated framed messages yet.
        },
      },
    });

    const actualPort = this.server.port ?? 0;
    return { port: actualPort, url: `http://127.0.0.1:${actualPort}` };
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  private async streamTurn(
    req: Parameters<ClaudeBackend['startTurn']>[0],
    convId: string,
  ): Promise<void> {
    try {
      for await (const ev of this.options.backend.startTurn(req)) {
        this.broadcast(this.wrap(ev, convId));
      }
    } catch (err) {
      this.broadcast(
        this.wrap(
          {
            kind: 'turn.error',
            turn_id: req.turn_id,
            error: {
              kind: 'cli_crashed',
              retryable: true,
              detail: err instanceof Error ? err.message : String(err),
            },
          },
          convId,
        ),
      );
    }
  }

  private wrap(ev: BackendEvent, convId: string): EventEnvelope {
    return {
      v: 1,
      id: this.envelopeIds.next(),
      ts: Date.now(),
      kind: ev.kind,
      conv_id: convId,
      payload: ev,
    };
  }

  private broadcast(envelope: EventEnvelope): void {
    const data = JSON.stringify(envelope);
    for (const ws of this.sockets) {
      try {
        ws.send(data);
      } catch {
        // ignore send errors; socket will be culled on close
      }
    }
  }
}

class EnvelopeIdSource {
  private counter = 0;

  next(): string {
    this.counter++;
    // Deterministic v4-shaped uuid for tests that don't care about randomness.
    const hex = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }
}
