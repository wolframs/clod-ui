/**
 * Tests for `EngineProvider` + `useEngine`.
 *
 * Surface limitation: Bun's test runner doesn't ship a DOM, and we have not
 * yet introduced Vitest + happy-dom + RTL. `renderToString` from
 * `react-dom/server` is enough to verify the synchronous contract:
 *   - useEngine outside provider throws with a useful message;
 *   - useEngine inside provider returns the injected client (identity check).
 *
 * Async hook lifecycle (useEffect, state transitions) is reserved for the
 * Vitest harness landing in PR #15. See plan §5.
 */
import type { Client } from '@clod-ui/contracts/client';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { EngineProvider, useEngine } from '../src/lib/engine-context.tsx';

function makeFakeClient(): Client {
  // Identity-only fake: the tests never invoke any method, they just check
  // that the same object handed to the provider reaches the hook.
  return {} as Client;
}

describe('useEngine', () => {
  test('throws when called outside <EngineProvider>', () => {
    function Consumer(): JSX.Element {
      useEngine();
      return <span>unreachable</span>;
    }
    let caught: unknown;
    try {
      renderToString(<Consumer />);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('useEngine');
    expect((caught as Error).message).toContain('EngineProvider');
  });

  test('returns the injected client when wrapped in <EngineProvider>', () => {
    const fakeClient = makeFakeClient();
    function Consumer(): JSX.Element {
      const { client } = useEngine();
      // We render a string-encoded identity check; renderToString preserves
      // attribute values verbatim, so the test can grep for the marker.
      return <span data-test={String(client === fakeClient)}>marker</span>;
    }
    const html = renderToString(
      <EngineProvider client={fakeClient}>
        <Consumer />
      </EngineProvider>,
    );
    expect(html).toContain('data-test="true"');
    expect(html).toContain('marker');
  });

  test('the same client instance is returned across nested consumers', () => {
    const fakeClient = makeFakeClient();
    function Inner(): JSX.Element {
      const { client } = useEngine();
      return <span id="inner" data-eq={String(client === fakeClient)} />;
    }
    function Outer(): JSX.Element {
      const { client } = useEngine();
      return (
        <div data-eq={String(client === fakeClient)}>
          <Inner />
        </div>
      );
    }
    const html = renderToString(
      <EngineProvider client={fakeClient}>
        <Outer />
      </EngineProvider>,
    );
    // Both consumers got the same identity.
    expect(html.match(/data-eq="true"/g)?.length).toBe(2);
  });
});
