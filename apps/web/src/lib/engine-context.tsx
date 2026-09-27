/**
 * `EngineProvider` + `useEngine` — single-client React context.
 *
 * The provider takes a fully-constructed `Client` (built once in `main.tsx`)
 * and exposes it through context. Consumers reach for `useEngine()` and get
 * the same client instance every time. `useEngine` outside the provider
 * throws; the standard React pattern, named in the error message so a
 * misplaced hook surfaces immediately in the dev console.
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr14-engine-provider-v1.md §3.
 */
import type { Client } from '@clod-ui/contracts/client';
import { createContext, useContext, type ReactNode } from 'react';

interface EngineContextValue {
  client: Client;
}

/**
 * Sentinel symbol used as the context default. `useEngine` checks identity
 * against this sentinel to detect "consumer rendered outside provider" and
 * throws with a useful message. We use a module-private symbol rather than
 * `null` so the context's typed surface stays narrow (consumers never see
 * a nullable client).
 */
const SENTINEL = Symbol('EngineContext default — useEngine called outside EngineProvider');

const EngineContext = createContext<EngineContextValue | typeof SENTINEL>(SENTINEL);
EngineContext.displayName = 'EngineContext';

export interface EngineProviderProps {
  client: Client;
  children: ReactNode;
}

export function EngineProvider({ client, children }: EngineProviderProps): JSX.Element {
  // We construct a fresh value every render to keep things simple; the
  // referential cost is negligible (one object) and consumers should not
  // depend on identity stability of the value object — they read `.client`.
  return <EngineContext.Provider value={{ client }}>{children}</EngineContext.Provider>;
}

/**
 * Returns `{ client }` from the surrounding `EngineProvider`. Throws if
 * called outside the provider.
 */
export function useEngine(): EngineContextValue {
  const value = useContext(EngineContext);
  if (value === SENTINEL) {
    throw new Error('useEngine() called outside <EngineProvider>. Wrap your app at the root.');
  }
  return value;
}
