/**
 * Top-level React error boundary. Catches render-time errors from any
 * descendant component and shows a typed fallback UI in their place
 * rather than a white-screened app.
 *
 * Why a class component: React still requires `componentDidCatch` /
 * `getDerivedStateFromError` to be implemented on a class. There is no
 * hook equivalent (useErrorBoundary remains experimental in upstream
 * React). The class is small and isolated; everything else in the app
 * stays a function component.
 *
 * The boundary deliberately does not try to recover or retry. The
 * fallback shows the error verbatim (with full message in title attr
 * for hover) and a "Reload" button that calls window.location.reload().
 * Render errors are typically programmer mistakes; making the user
 * stare at the original message + a clear escape hatch is more honest
 * than auto-retrying into the same broken render.
 *
 * Spec: docs/INVARIANTS.md (I-3 — `data-state` markers for hermetic
 * tests).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional override for the fallback UI; useful in Storybook later. */
  fallback?: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught render error', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error);
      return <DefaultErrorFallback error={error} />;
    }
    return this.props.children;
  }
}

const MAX_VISIBLE_MESSAGE = 200;

function DefaultErrorFallback({ error }: { error: Error }): ReactNode {
  const message = error.message || 'Unknown error';
  const truncated =
    message.length > MAX_VISIBLE_MESSAGE
      ? message.slice(0, MAX_VISIBLE_MESSAGE - 1) + '\u2026'
      : message;
  return (
    <div
      data-test="error-boundary"
      data-state="error"
      role="alert"
      className="flex h-screen items-center justify-center p-8"
    >
      <div className="w-full max-w-xl space-y-4 rounded-lg border border-destructive/50 bg-destructive/5 p-6">
        <h1 className="text-lg font-semibold text-destructive">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The web app hit an unexpected render error. The engine is unaffected; reloading will
          re-mount the React tree.
        </p>
        <pre
          className="overflow-x-auto rounded bg-muted p-3 text-xs text-foreground"
          title={message}
        >
          {truncated}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
