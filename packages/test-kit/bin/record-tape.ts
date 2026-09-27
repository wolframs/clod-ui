#!/usr/bin/env bun
import { parseArgs } from 'node:util';

import { recordTape } from '../src/tape-recorder.ts';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'prompt-file': { type: 'string' },
    cwd: { type: 'string' },
    'allow-tools': { type: 'string' },
    model: { type: 'string' },
    'out-dir': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

if (!values.name || !values['prompt-file']) {
  console.error(
    'usage: bun run tape:record --name <slug> --prompt-file <path> [--cwd <path>] [--allow-tools <list>] [--model <id>] [--out-dir <path>]',
  );
  process.exit(2);
}

const opts: Parameters<typeof recordTape>[0] = {
  name: values.name,
  promptFile: values['prompt-file'],
  ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
  ...(values['allow-tools'] !== undefined
    ? {
        allowTools: values['allow-tools']
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }
    : {}),
  ...(values.model !== undefined ? { model: values.model } : {}),
  ...(values['out-dir'] !== undefined ? { outDir: values['out-dir'] } : {}),
};

const { path } = await recordTape(opts);
console.log(`Recorded: ${path}`);
