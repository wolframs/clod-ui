import { useCallback, useEffect, useRef, useState } from 'react';

import { Composer } from '@/components/composer';
import { HealthBadge } from '@/components/health-badge';
import { Sidebar } from '@/components/sidebar';
import { TranscriptHistory } from '@/components/transcript-history';
import { TurnView } from '@/components/turn-view';
import { useEngine } from '@/lib/engine-context';
import { useConversations } from '@/lib/use-conversations';
import { useHealth } from '@/lib/use-health';
import { useSubmitTurn } from '@/lib/use-submit-turn';
import { useTranscript } from '@/lib/use-transcript';
import { useTurnStream } from '@/lib/use-turn-stream';

const generateConvId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes (rare in 2026).
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padStart(12, '0');
};

export function App(): JSX.Element {
  const { client } = useEngine();
  const health = useHealth();
  const conversations = useConversations();
  // TODO(layout-state): hoist selectedId into a typed layout-state module
  // + localStorage when the 3-pane PR (#18d) lands.
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  // useTurnStream is mounted unconditionally so the hook tree stays stable;
  // `enabled: false` short-circuits to idle when no conversation is selected.
  const turnState = useTurnStream({
    conv_id: selectedId ?? '',
    enabled: selectedId !== undefined,
  });

  // useTranscript follows the same pattern; gives us historical messages
  // above the active turn. The `not_configured` status surfaces when the
  // engine was started without --projects-dir.
  const transcript = useTranscript({
    conv_id: selectedId ?? '',
    enabled: selectedId !== undefined,
  });

  // Refetch the transcript on every active-turn terminator so freshly-
  // completed turns join the historical view without a manual reload. The
  // ref tracks which terminator we've already reacted to (a single status
  // tick can re-fire across renders); we only refetch on the *transition*
  // into a terminal state.
  const lastTerminalRef = useRef<string | null>(null);
  const turnIsTerminal =
    turnState.status === 'completed' ||
    turnState.status === 'cancelled' ||
    turnState.status === 'errored';
  const turnId = turnIsTerminal ? turnState.turn_id : null;
  useEffect(() => {
    if (turnId !== null && turnId !== lastTerminalRef.current) {
      lastTerminalRef.current = turnId;
      void transcript.refetch();
    }
  }, [turnId, transcript]);

  const submit = useSubmitTurn({ conv_id: selectedId });

  const handleNewConversation = useCallback(() => {
    setSelectedId(generateConvId());
  }, []);

  const handleSubmit = useCallback(
    (text: string) => {
      void submit.submit({ user_message: text });
    },
    [submit],
  );

  const handleCancel = useCallback(
    (turnId: string) => {
      if (!selectedId) return;
      // TODO(sidebar-live-refresh): also refresh sidebar on conversation.titled.
      void client.cancelTurn({ conv_id: selectedId, turn_id: turnId }).catch(() => {
        // Cancel errors are best-effort; the engine's classification will
        // surface as turn.cancelled or turn.error in the stream.
      });
    },
    [client, selectedId],
  );

  return (
    <div className="flex h-screen min-h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        state={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={handleNewConversation}
        className="w-72 shrink-0"
      />
      <main className="relative flex flex-1 flex-col overflow-hidden">
        {selectedId === undefined ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-6 p-8"
            data-test="empty-pane"
          >
            <h1 className="text-2xl font-semibold tracking-tight">Clod UI</h1>
            <HealthBadge state={health} />
            <p className="max-w-md text-center text-sm text-muted-foreground">
              Select a conversation, or click <span className="font-medium">+ New</span> to start
              one.
            </p>
          </div>
        ) : (
          // History above + active turn below in one scrollable column. The
          // sticky-bottom auto-scroll behavior described in
          // // TODO(scroll-to-bottom) lands in PR #18d.
          <div className="flex flex-1 flex-col overflow-hidden" data-test="conversation-pane">
            <TranscriptHistory state={transcript.state} className="flex-1" />
            {turnState.status !== 'idle' ? (
              <TurnView state={turnState} className="shrink-0 border-t border-border" />
            ) : null}
          </div>
        )}
        <Composer
          convId={selectedId}
          turnState={turnState}
          submitState={submit.state}
          lastSubmittedTurnId={submit.lastTurnId}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onResetError={submit.reset}
        />
        {/* Footer with health badge stays visible even while a turn renders. */}
        <footer className="flex shrink-0 items-center justify-end border-t border-border px-4 py-1.5">
          <HealthBadge state={health} />
        </footer>
      </main>
    </div>
  );
}
