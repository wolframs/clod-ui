import { describe, expect, test } from 'bun:test';

import {
  ClodErrorSchema,
  EventEnvelopeSchema,
  HealthResponseSchema,
  PROTOCOL_VERSION,
  assertProtocolVersion,
} from '../src/index.ts';

describe('EventEnvelope', () => {
  test('accepts a well-formed envelope', () => {
    const good = {
      v: 1,
      id: '00000000-0000-4000-8000-000000000000',
      ts: 1,
      kind: 'assistant.delta',
      payload: { text: 'hi' },
    };
    expect(() => EventEnvelopeSchema.parse(good)).not.toThrow();
  });

  test('rejects wrong version', () => {
    const bad = {
      v: 2,
      id: '00000000-0000-4000-8000-000000000000',
      ts: 1,
      kind: 'x',
      payload: null,
    };
    expect(() => EventEnvelopeSchema.parse(bad)).toThrow();
  });

  test('rejects missing id', () => {
    const bad = { v: 1, ts: 1, kind: 'x', payload: null };
    expect(() => EventEnvelopeSchema.parse(bad)).toThrow();
  });
});

describe('HealthResponse', () => {
  test('accepts an ok response', () => {
    const good = {
      cli: 'ok',
      version: '2.1.118',
      engine_version: '0.0.0',
      started_at: Date.now(),
    };
    expect(() => HealthResponseSchema.parse(good)).not.toThrow();
  });

  test('rejects unknown cli status', () => {
    const bad = { cli: 'exploded', engine_version: '0.0.0', started_at: 0 };
    expect(() => HealthResponseSchema.parse(bad)).toThrow();
  });
});

describe('ClodError', () => {
  test('accepts a cli_missing error', () => {
    const good = { kind: 'cli_missing', retryable: false };
    expect(() => ClodErrorSchema.parse(good)).not.toThrow();
  });

  test('accepts a rate_limited error with retry_after_ms', () => {
    const good = { kind: 'rate_limited', retryable: true, retry_after_ms: 1000 };
    expect(() => ClodErrorSchema.parse(good)).not.toThrow();
  });

  test('rejects unknown kind', () => {
    const bad = { kind: 'bogus', retryable: false };
    expect(() => ClodErrorSchema.parse(bad)).toThrow();
  });
});

describe('ProtocolVersion', () => {
  test('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test('assertProtocolVersion passes on 1, throws on others', () => {
    expect(() => assertProtocolVersion(1)).not.toThrow();
    expect(() => assertProtocolVersion(2)).toThrow();
    expect(() => assertProtocolVersion('1')).toThrow();
  });
});
