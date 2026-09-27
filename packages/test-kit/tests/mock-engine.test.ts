import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { MockEngineServer, ScriptedBackend, TypedTestClient, script } from '../src/index.ts';

describe('MockEngineServer + TypedTestClient round-trip', () => {
  let server: MockEngineServer;
  let client: TypedTestClient;
  let baseUrl = '';

  beforeEach(async () => {
    const built = script().init('sess-1').assistantText('hello').result().end();
    server = new MockEngineServer({ backend: new ScriptedBackend(built) });
    const { url } = await server.start(0);
    baseUrl = url;
    client = new TypedTestClient({ baseUrl });
    await client.connect();
  }, 15000);

  afterEach(async () => {
    await client.close();
    await server.stop();
  }, 15000);

  test('/health returns a valid payload', async () => {
    const h = await client.health();
    expect(h.cli).toBe('ok');
    expect(h.engine_version).toBeDefined();
  }, 15000);

  test('submitting a turn broadcasts envelopes ending in turn.result', async () => {
    const convId = '00000000-0000-4000-8000-000000000001';
    await client.submitTurn({
      conv_id: convId,
      turn_id: 'turn-1',
      user_message: 'hello',
    });
    const result = await client.awaitEvent(
      { kind: 'turn.result', conv_id: convId },
      { timeout: 5000 },
    );
    expect(result.kind).toBe('turn.result');
    const all = client.recordEvents(convId);
    expect(all.map((e) => e.kind)).toEqual(['system.init', 'assistant.delta', 'turn.result']);
  }, 15000);
});
