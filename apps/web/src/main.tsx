import { LocalHttpTransport, createClient } from '@clod-ui/contracts/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { ErrorBoundary } from './components/error-boundary.tsx';
import './index.css';
import { EngineProvider } from './lib/engine-context.tsx';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('root element missing');
}

// Resolve the engine base URL. In production, the launcher serves the engine
// and the web app from the same origin, so `window.location` is the default.
// `VITE_ENGINE_URL` overrides for development against a separately-running
// engine (e.g. `bun run apps/engine/src/index.ts` on a different port).
const baseUrl =
  (import.meta.env['VITE_ENGINE_URL'] as string | undefined) ??
  `${window.location.protocol}//${window.location.host}`;
const transport = new LocalHttpTransport({ baseUrl });
const client = createClient({ transport });

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <EngineProvider client={client}>
        <App />
      </EngineProvider>
    </ErrorBoundary>
  </StrictMode>,
);
