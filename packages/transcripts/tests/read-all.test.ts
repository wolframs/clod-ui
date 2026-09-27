import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { encodeCwd, readAllLines } from '../src/index.ts';

let root = '';

beforeEach(async () => {
  root = await Bun.write(
    join(tmpdir(), `clod-read-all-${Date.now()}-${Math.random().toString(36).slice(2)}/.gitkeep`),
    '',
  ).then(async () => {
    const dir = join(
      tmpdir(),
      `clod-read-all-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeJsonl = async (path: string, lines: string[]): Promise<void> => {
  const content = lines.length === 0 ? '' : lines.join('\n') + '\n';
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
};

describe('readAllLines', () => {
  test('returns empty array when projects dir does not exist', async () => {
    const result = await readAllLines({
      projectsDir: join(root, 'does-not-exist'),
      cwd: '/some/cwd',
      sessionId: 'abc',
    });
    expect(result).toEqual([]);
  });

  test('returns empty array when conversation dir does not exist', async () => {
    const projectsDir = join(root, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const result = await readAllLines({
      projectsDir,
      cwd: '/no/such/cwd',
      sessionId: 'abc',
    });
    expect(result).toEqual([]);
  });

  test('returns empty array when JSONL file does not exist', async () => {
    const projectsDir = join(root, 'projects');
    const cwd = '/Users/test/proj';
    await mkdir(join(projectsDir, encodeCwd(cwd)), { recursive: true });
    const result = await readAllLines({
      projectsDir,
      cwd,
      sessionId: 'missing-session',
    });
    expect(result).toEqual([]);
  });

  test('reads all lines from JSONL with line_number + byte_offset', async () => {
    const projectsDir = join(root, 'projects');
    const cwd = '/Users/test/proj';
    const sessionId = 'sess-1';
    const path = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    await writeJsonl(path, [
      '{"type":"user","content":"hi"}',
      '{"type":"assistant","content":"hello"}',
      '{"type":"user","content":"again"}',
    ]);

    const result = await readAllLines({ projectsDir, cwd, sessionId });
    expect(result.length).toBe(3);
    expect(result[0]?.line_number).toBe(0);
    expect(result[0]?.byte_offset).toBe(0);
    expect(result[0]?.raw).toEqual({ type: 'user', content: 'hi' });
    expect(result[1]?.line_number).toBe(1);
    expect(result[1]?.byte_offset).toBeGreaterThan(0);
    expect(result[2]?.line_number).toBe(2);
    expect(result[2]?.byte_offset).toBeGreaterThan(result[1]!.byte_offset);
  });

  test('drops trailing empty lines (file ends with \\n)', async () => {
    const projectsDir = join(root, 'projects');
    const cwd = '/Users/test/proj';
    const sessionId = 'sess-2';
    const path = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    // writeJsonl appends a trailing newline; that should not produce an extra empty line
    await writeJsonl(path, ['{"a":1}', '{"b":2}']);

    const result = await readAllLines({ projectsDir, cwd, sessionId });
    expect(result.length).toBe(2);
  });

  test('preserves invalid lines with parse_error set', async () => {
    const projectsDir = join(root, 'projects');
    const cwd = '/Users/test/proj';
    const sessionId = 'sess-3';
    const path = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    await writeJsonl(path, ['{"valid":1}', 'not json', '{"valid":2}']);

    const result = await readAllLines({ projectsDir, cwd, sessionId });
    expect(result.length).toBe(3);
    expect(result[0]?.parse_error).toBeUndefined();
    expect(result[1]?.parse_error).toBeDefined();
    expect(result[1]?.parse_error?.raw_text).toBe('not json');
    expect(result[2]?.parse_error).toBeUndefined();
  });

  test('handles empty JSONL file (zero lines)', async () => {
    const projectsDir = join(root, 'projects');
    const cwd = '/Users/test/proj';
    const sessionId = 'sess-empty';
    const path = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    await writeJsonl(path, []);

    const result = await readAllLines({ projectsDir, cwd, sessionId });
    expect(result).toEqual([]);
  });

  test('byte_offset increases monotonically with multibyte characters', async () => {
    const projectsDir = join(root, 'projects');
    const cwd = '/Users/test/proj';
    const sessionId = 'sess-utf8';
    const path = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    await writeJsonl(path, ['{"text":"héllo"}', '{"text":"🌀"}']);

    const result = await readAllLines({ projectsDir, cwd, sessionId });
    expect(result.length).toBe(2);
    expect(result[1]?.byte_offset).toBeGreaterThan(0);
    // First line is 16 ASCII + 1 multi-byte é (2 bytes) → 17 chars but 18 bytes; +1 for \n
    expect(result[1]?.byte_offset).toBe(Buffer.byteLength('{"text":"héllo"}', 'utf8') + 1);
  });
});
