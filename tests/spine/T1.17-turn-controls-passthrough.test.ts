/**
 * T1.17 — Turn controls pass through to the backend's argv.
 *
 * Contract: `model` and `thinking_effort` in the `POST /turns` body reach
 * the backend's `TurnRequest` unmodified, and `compose()` of that request
 * yields the corresponding `--model` / `--effort` argv pairs. Absent
 * controls stay absent (no flags composed). An unrecognized
 * `thinking_effort` is a 400 and never reaches the backend (closed
 * vocabulary — PR #24 decision D3).
 *
 * PR: plans/2026-06-10-clod-ui-pr24-turn-controls-v1.md §D8.
 *
 * Extended by PR #25 (plans/2026-06-12-clod-ui-pr25-system-prompt-editor-v1.md
 * §D1/D6): `system_prompt {mode, text}` composes to `--append-system-prompt`
 * (append) / `--system-prompt` (override); a malformed `system_prompt` is a
 * 400 and never reaches the backend.
 *
 * Extended by PR #28 (plans/2026-06-12-clod-ui-pr28-raw-flags-v1.md §D2/D6):
 * `extra_argv` survives the wire and composes verbatim as the argv tail,
 * after every composed flag; malformed `extra_argv` is a 400.
 *
 * Extended by PR #29 (plans/2026-06-12-clod-ui-pr29-tools-editor-v1.md §D6):
 * `allowed_tools` + `disallowed_tools` in the POST body reach the backend
 * unmodified and compose to `--allowedTools` / `--disallowedTools` argv
 * (T1.02 pins the same flags only for the engine-injected resume path).
 */
import type { BackendEvent, ClaudeBackend, TurnRequest } from '@clod-ui/backend';
import { compose } from '@clod-ui/backend';
import { ScriptedBackend, TestEnv, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

const CONV_UUID = '17171717-1717-4717-8717-171717171717';

/** Delegates to ScriptedBackend, recording every TurnRequest it receives. */
class RecordingBackend implements ClaudeBackend {
  readonly requests: TurnRequest[] = [];
  constructor(private readonly inner: ScriptedBackend) {}
  startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    this.requests.push(req);
    return this.inner.startTurn(req);
  }
  cancel(turnId: string): Promise<void> {
    return this.inner.cancel(turnId);
  }
  version(): Promise<string> {
    return this.inner.version();
  }
  health(): ReturnType<ClaudeBackend['health']> {
    return this.inner.health();
  }
}

let env: TestEnv;

beforeEach(async () => {
  env = await TestEnv.create({ name: 't1.17' });
});

afterEach(async () => {
  await env.dispose();
});

function makeBackend(): RecordingBackend {
  const built = script().init('s-17').assistantText('ok').result().end();
  return new RecordingBackend(new ScriptedBackend(built));
}

async function postTurn(
  ctx: { app: { fetch: (req: Request) => Response | Promise<Response> } },
  body: Record<string, unknown>,
): Promise<Response> {
  return ctx.app.fetch(
    new Request(`http://x/conversations/${CONV_UUID}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function waitForRequest(backend: RecordingBackend): Promise<TurnRequest> {
  for (let i = 0; i < 100; i++) {
    const req = backend.requests[0];
    if (req) return req;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('backend never received a TurnRequest');
}

describe('T1.17 turn controls passthrough', () => {
  test('model + thinking_effort survive the wire and compose to argv flags', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-a',
      user_message: 'hi',
      model: 'sonnet',
      thinking_effort: 'think_hard',
    });
    expect(res.status).toBe(202);

    const req = await waitForRequest(backend);
    expect(req.model).toBe('sonnet');
    expect(req.thinking_effort).toBe('think_hard');

    const { argv } = compose(req);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('medium');
  });

  test('absent controls stay absent — no --model / --effort composed', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, { turn_id: 'turn-17-b', user_message: 'hi' });
    expect(res.status).toBe(202);

    const req = await waitForRequest(backend);
    expect(req.model).toBeUndefined();
    expect(req.thinking_effort).toBeUndefined();

    const { argv } = compose(req);
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
  });

  test('unrecognized thinking_effort is a 400 and never reaches the backend', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-c',
      user_message: 'hi',
      thinking_effort: 'banana',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('thinking_effort must be one of');

    // Give the (non-existent) fire-and-forget a beat, then assert silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.requests.length).toBe(0);
  });

  test('system_prompt append mode composes to --append-system-prompt', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-d',
      user_message: 'hi',
      system_prompt: { mode: 'append', text: 'be terse' },
    });
    expect(res.status).toBe(202);

    const req = await waitForRequest(backend);
    expect(req.system_prompt).toEqual({ mode: 'append', text: 'be terse' });

    const { argv } = compose(req);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('be terse');
    expect(argv).not.toContain('--system-prompt');
  });

  test('system_prompt override mode composes to --system-prompt', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-e',
      user_message: 'hi',
      system_prompt: { mode: 'override', text: 'you are a pirate' },
    });
    expect(res.status).toBe(202);

    const req = await waitForRequest(backend);
    expect(req.system_prompt).toEqual({ mode: 'override', text: 'you are a pirate' });

    const { argv } = compose(req);
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('you are a pirate');
    expect(argv).not.toContain('--append-system-prompt');
  });

  test('malformed system_prompt is a 400 and never reaches the backend', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-f',
      user_message: 'hi',
      system_prompt: { mode: 'replace', text: 'x' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('system_prompt.mode must be one of');

    await new Promise((r) => setTimeout(r, 50));
    expect(backend.requests.length).toBe(0);
  });

  test('extra_argv survives the wire and composes verbatim as the argv tail', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const tokens = ['--fork-session', '--model', 'haiku'];
    const res = await postTurn(ctx, {
      turn_id: 'turn-17-g',
      user_message: 'hi',
      model: 'sonnet',
      extra_argv: tokens,
    });
    expect(res.status).toBe(202);

    const req = await waitForRequest(backend);
    expect(req.extra_argv).toEqual(tokens);

    const { argv } = compose(req);
    // Verbatim tail: the last N tokens, after every composed flag
    // (--model sonnet and the --add-dir block both precede them).
    expect(argv.slice(-tokens.length)).toEqual(tokens);
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('--add-dir'));
    expect(argv.indexOf('--add-dir')).toBeLessThan(argv.length - tokens.length);
  });

  test('malformed extra_argv is a 400 and never reaches the backend', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-h',
      user_message: 'hi',
      extra_argv: ['--effort', 3],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('extra_argv must be an array of strings');

    await new Promise((r) => setTimeout(r, 50));
    expect(backend.requests.length).toBe(0);
  });

  test('allowed_tools + disallowed_tools survive the wire and compose to argv', async () => {
    const backend = makeBackend();
    const ctx = createApp({ backend });

    const res = await postTurn(ctx, {
      turn_id: 'turn-17-i',
      user_message: 'hi',
      allowed_tools: ['Read', 'Bash(npm run *)'],
      disallowed_tools: ['WebSearch'],
    });
    expect(res.status).toBe(202);

    const req = await waitForRequest(backend);
    expect(req.allowed_tools).toEqual(['Read', 'Bash(npm run *)']);
    expect(req.disallowed_tools).toEqual(['WebSearch']);

    const { argv } = compose(req);
    const allowedIdx = argv.indexOf('--allowedTools');
    expect(argv.slice(allowedIdx + 1, allowedIdx + 3)).toEqual(['Read', 'Bash(npm run *)']);
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('WebSearch');
  });
});
