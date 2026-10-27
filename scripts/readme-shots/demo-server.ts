#!/usr/bin/env bun
/**
 * README screenshot server: the real engine and the built SPA on 4619,
 * driven by a scripted demo backend instead of the CLI. Each turn also
 * writes Claude-Code-shaped transcript lines, so the history pane renders
 * as it does in real use. The last turn of the "faster" conversation is
 * deliberately left out of the transcript: it stays the live turn view,
 * with its status pill and cache badge.
 *
 * Usage (docs/PUBLISHING.md): build the web app, start this, run shoot.ts.
 */
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BackendEvent, ClaudeBackend, TurnRequest } from '@clod-ui/backend';
import type { ModelInfo } from '@clod-ui/contracts';
import { ManifestStore } from '@clod-ui/manifest';
import { encodeCwd } from '@clod-ui/transcripts';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp, startEngineServer } from '../../apps/engine/src/index.ts';

const appDataDir = mkdtempSync(join(tmpdir(), 'clod-ui-demo-'));
const projectsDir = join(appDataDir, 'claude-projects');
function record(
  req: TurnRequest,
  sid: string,
  entries: Array<{ type: 'user' | 'assistant'; content: unknown[] }>,
): void {
  const dir = join(projectsDir, encodeCwd(req.cwd));
  mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    appendFileSync(
      join(dir, `${sid}.jsonl`),
      JSON.stringify({
        type: e.type,
        sessionId: sid,
        timestamp: new Date().toISOString(),
        message: { role: e.type, content: e.content },
      }) + '\n',
    );
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const READ_RESULT = `export function warmReusable(warm: WarmProcessShape, next: NextTurnShape): boolean {
  if (warm.cwd !== next.cwd) return false;
  if (next.resume_session_id === undefined) return false;
  if (warm.sessionId === undefined || warm.sessionId !== next.resume_session_id) return false;
  …`;
const ANSWER = `Because turn 2 never starts a process. After turn 1's \`result\`, the CLI stays alive with stdin open, and the next message is written straight into it:

1. **No boot.** No CLI startup, no MCP reconnects.
2. **Hooks run once.** \`SessionStart\` fired on turn 1 and doesn't fire again, so its context isn't appended a second time.
3. **Same prefix.** Everything before this message comes back from the prompt cache.

The process is only replaced when something it was *started with* changes — model, effort, prompt, tools, raw flags — which \`warmReusable\` checks before every turn.`;

const backend: ClaudeBackend = {
  claudeBinary: 'claude',
  async version() {
    return '2.1.310';
  },
  async health() {
    return { cli: 'ok', version: '2.1.310' };
  },
  async cancel() {},
  // The picker's list, as the CLI reports it (PR #42); a short cut of a real one.
  async listModels(): Promise<ModelInfo[]> {
    const all: ModelInfo['effort_levels'] = ['low', 'medium', 'high', 'xhigh', 'max'];
    return [
      {
        value: 'default',
        display_name: 'Default (recommended)',
        resolved_model: 'claude-fable-5-1',
        effort_levels: all,
      },
      {
        value: 'opus',
        display_name: 'Opus 5.5',
        resolved_model: 'claude-opus-5-5',
        effort_levels: all,
      },
      {
        value: 'fable',
        display_name: 'Fable 5.1',
        resolved_model: 'claude-fable-5-1',
        effort_levels: all,
      },
      {
        value: 'sonnet',
        display_name: 'Sonnet 5.5',
        resolved_model: 'claude-sonnet-5-5',
        effort_levels: all,
      },
      {
        value: 'haiku',
        display_name: 'Haiku 5.5',
        resolved_model: 'claude-haiku-5-5',
        effort_levels: all,
      },
    ];
  },
  reusableArgv(req: TurnRequest) {
    return req.resume_session_id ? ['claude', '-p', '--model', 'opus'] : undefined;
  },
  async *startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    const t = req.turn_id;
    const sid = `demo-${req.conv_id.slice(0, 8)}`;
    yield { kind: 'system.init', turn_id: t, session_id: sid, model: 'claude-fable-5-1' };
    record(req, sid, [{ type: 'user', content: [{ type: 'text', text: req.user_message }] }]);
    if (req.user_message.includes('badge')) {
      const txt =
        'Per turn: uncached input ↑, then the prompt cache — what share of the prompt was **read** back and how much was newly **written** — then output ↓. On a warm conversation the read side should dwarf everything else.';
      record(req, sid, [{ type: 'assistant', content: [{ type: 'text', text: txt }] }]);
      await sleep(150);
      yield { kind: 'assistant.delta', turn_id: t, text: txt };
      yield {
        kind: 'turn.result',
        turn_id: t,
        usage: {
          input_tokens: 2,
          output_tokens: 64,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 56021,
        },
      };
      return;
    }
    if (!req.user_message.includes('faster')) {
      await sleep(150);
      const txt =
        'Done — the attachment arrived as a base64 image block, and I can see a red square.';
      record(req, sid, [{ type: 'assistant', content: [{ type: 'text', text: txt }] }]);
      yield { kind: 'assistant.delta', turn_id: t, text: txt };
      yield {
        kind: 'turn.result',
        turn_id: t,
        usage: {
          input_tokens: 4,
          output_tokens: 21,
          cache_read_input_tokens: 38211,
          cache_creation_input_tokens: 96,
        },
      };
      return;
    }
    await sleep(150);
    yield {
      kind: 'thinking.delta',
      turn_id: t,
      text: 'The question is about the warm-process path. Check the reuse rule before answering.',
    };
    yield {
      kind: 'tool.use',
      turn_id: t,
      tool_use_id: 'tu-1',
      name: 'Read',
      input: { file_path: 'packages/backend/src/warm-reuse.ts', limit: 4 },
    };
    await sleep(150);
    yield { kind: 'tool.result', turn_id: t, tool_use_id: 'tu-1', content: READ_RESULT };
    for (const part of ANSWER.split(/(?<=\n\n)/)) {
      await sleep(120);
      yield { kind: 'assistant.delta', turn_id: t, text: part };
    }
    yield {
      kind: 'turn.result',
      turn_id: t,
      usage: {
        input_tokens: 2,
        output_tokens: 312,
        cache_read_input_tokens: 57141,
        cache_creation_input_tokens: 1120,
      },
    };
  },
};

const context = createApp({
  backend,
  store: new ManifestStore(appDataDir),
  db: openDb({ path: join(appDataDir, 'engine.sqlite') }),
  diagnostics: {},
  transcripts: { projectsDir, pollIntervalMs: 100, debounceMs: 20 },
  titler: {
    async suggestTitle(i) {
      return i.user_message.includes('badge')
        ? 'Warm turns and the cache badge'
        : 'Attachment smoke test';
    },
  },
  static: { dir: resolve(import.meta.dir, '../../apps/web/dist') },
});
startEngineServer(context, { port: 4619 });
console.log('[demo] http://127.0.0.1:4619');
