import type { ChatMessage } from '@clod-ui/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Composer } from '@/components/composer';
import { ConnectionBanner } from '@/components/connection-banner';
import { DiagnosticsPanel } from '@/components/diagnostics-panel';
import { HealthBadge } from '@/components/health-badge';
import { MobileControls } from '@/components/mobile-controls';
import { MobileTopBar } from '@/components/mobile-top-bar';
import { ProfileLabel } from '@/components/profile-picker';
import { SettingsPanel } from '@/components/settings-panel';
import { ShortcutOverlay } from '@/components/shortcut-overlay';
import { Sidebar } from '@/components/sidebar';
import { SkillsPanel } from '@/components/skills-panel';
import { ThemeToggle } from '@/components/theme-toggle';
import { TranscriptHistory } from '@/components/transcript-history';
import { TurnControlsBar } from '@/components/turn-controls-bar';
import { TurnView } from '@/components/turn-view';
import { useEngine } from '@/lib/engine-context';
import type { KeyAction } from '@/lib/keymap';
import { hasProfileChoice, profileForTurn, profileLabelFor } from '@/lib/profiles';
import type { TurnControls } from '@/lib/turn-controls';
import { effectiveExtraArgv, effectiveSystemPrompt } from '@/lib/turn-controls';
import { useAttachmentUploads } from '@/lib/use-attachment-uploads';
import { useBackDismiss } from '@/lib/use-back-dismiss';
import { useCompact } from '@/lib/use-compact';
import { useConversationRoute } from '@/lib/use-conversation-route';
import { useConversations } from '@/lib/use-conversations';
import { useDiagnostics } from '@/lib/use-diagnostics';
import { useHealth } from '@/lib/use-health';
import { useKeymap } from '@/lib/use-keymap';
import { useModels } from '@/lib/use-models';
import { useProfiles } from '@/lib/use-profiles';
import { useSettings } from '@/lib/use-settings';
import { useSkills } from '@/lib/use-skills';
import { useStickyBottom } from '@/lib/use-sticky-bottom';
import { useSubmitTurn } from '@/lib/use-submit-turn';
import { useTheme } from '@/lib/use-theme';
import { useTranscript } from '@/lib/use-transcript';
import { useTurnStream } from '@/lib/use-turn-stream';
import { cn } from '@/lib/utils';

const generateConvId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes (rare in 2026).
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padStart(12, '0');
};

const RESOLVED_MODELS_KEY = 'clod-ui.resolved-models';

function loadResolvedModels(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(RESOLVED_MODELS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function saveResolvedModels(map: Record<string, string>): void {
  try {
    globalThis.localStorage?.setItem(RESOLVED_MODELS_KEY, JSON.stringify(map));
  } catch {
    // Storage full or blocked: the labels just stay unlearned.
  }
}

/**
 * Does the transcript end with this turn's reply? The live text is the
 * turn's text blocks joined by blank lines, so the transcript's last
 * assistant text block is its tail.
 */
function transcriptEndsWith(messages: readonly ChatMessage[], liveText: string): boolean {
  const live = liveText.trim();
  if (live === '') return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    const texts = m.content.filter((b) => b.type === 'text');
    if (texts.length === 0) continue;
    const last = texts[texts.length - 1];
    if (m.role !== 'assistant' || last === undefined || last.type !== 'text') return false;
    const tail = last.text.trim();
    return tail !== '' && live.endsWith(tail);
  }
  return false;
}

export function App(): JSX.Element {
  const { client } = useEngine();
  const health = useHealth();
  // Bumped when the list can have changed: a turn ended (a fresh
  // conversation now exists) or the titler named one.
  const [conversationsKey, setConversationsKey] = useState(0);
  const refreshConversations = useCallback(() => setConversationsKey((k) => k + 1), []);
  const conversations = useConversations(conversationsKey);
  const theme = useTheme();
  // The selection lives in the URL hash (PR #44): a reload keeps it, Back
  // walks it.
  const { selectedId, select } = useConversationRoute();
  // Phone layout (PR #44). Open overlays hold a history entry there, so the
  // Back button closes them.
  const compact = useCompact();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerBack = useBackDismiss(compact && drawerOpen, () => setDrawerOpen(false));

  // The user's own message, shown above the live turn until the transcript
  // has it (the turn stream carries only the model's side).
  const [pendingUser, setPendingUser] = useState<{
    convId: string;
    text: string;
    /** History length at submit; the echo is looked for after it. */
    after: number;
  } | null>(null);
  // Which model each picker choice resolved to, learned from `system.init`.
  // The picker's fallback labels when `GET /models` is unavailable (PR #42).
  // Keyed by alias, `default` for none.
  const [resolvedModels, setResolvedModels] = useState<Record<string, string>>(loadResolvedModels);
  // Per turn: which picker choice it was submitted with (null once learned
  // or unknown) and how long the history was before it, so matching its
  // reply never looks at older messages.
  const turnMetaRef = useRef<Record<string, { modelKey: string | null; watermark: number }>>({});
  const nextSubmitRef = useRef<{ modelKey: string; watermark: number } | null>(null);

  // useTurnStream is mounted unconditionally so the hook tree stays stable;
  // `enabled: false` short-circuits to idle when no conversation is selected.
  // `connection` is the stream's own state — the banner reflects the socket
  // that actually feeds the turn view (PR #22).
  const { turn: turnState, connection } = useTurnStream({
    conv_id: selectedId ?? '',
    enabled: selectedId !== undefined,
    onAnyEnvelope: (env) => {
      // Replay on connect may re-send old titles; an extra list fetch is
      // cheap, and comparing engine and browser clocks would not be safe.
      if (env.kind === 'conversation.titled') {
        refreshConversations();
      }
      // The CLI can finish writing its transcript after the turn's result:
      // while a finished turn waits to be found in history, every tail
      // update of that conversation fetches it again.
      if (env.kind === 'transcript.updated' && absorbRef.current?.convId === env.conv_id) {
        refetchTranscriptRef.current();
      }
    },
  });

  const absorbRef = useRef<{
    convId: string;
    turnId: string;
    before: unknown;
    text: string;
    /** Only history after this index can hold the turn (no stale match). */
    after: number;
  } | null>(null);
  const refetchTranscriptRef = useRef<() => void>(() => {});

  const turnModel = turnState.status !== 'idle' ? turnState.model : undefined;
  const liveTurnId = turnState.status !== 'idle' ? turnState.turn_id : undefined;
  useEffect(() => {
    if (liveTurnId === undefined || turnModel === undefined) return;
    const meta = turnMetaRef.current[liveTurnId];
    const key = meta?.modelKey;
    if (meta === undefined || key === null || key === undefined) return;
    meta.modelKey = null;
    setResolvedModels((prev) => {
      if (prev[key] === turnModel) return prev;
      const next = { ...prev, [key]: turnModel };
      saveResolvedModels(next);
      return next;
    });
  }, [liveTurnId, turnModel]);

  // useTranscript follows the same pattern; gives us historical messages
  // above the active turn. The `not_configured` status surfaces when the
  // engine was started without --projects-dir.
  const transcript = useTranscript({
    conv_id: selectedId ?? '',
    enabled: selectedId !== undefined,
  });
  refetchTranscriptRef.current = transcript.refetch;

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
  // A completed turn is "absorbed" once the refetched transcript holds its
  // reply; from then on the history shows it and the live view steps aside,
  // instead of the same answer rendering twice.
  const [absorbedTurnId, setAbsorbedTurnId] = useState<string | null>(null);
  useEffect(() => {
    if (turnId !== null && turnId !== lastTerminalRef.current) {
      lastTerminalRef.current = turnId;
      if (turnState.status === 'completed' && selectedId !== undefined) {
        const before = transcript.state;
        absorbRef.current = {
          convId: selectedId,
          turnId,
          before,
          text: turnState.assistant_text,
          after:
            turnMetaRef.current[turnId]?.watermark ??
            (before.status === 'ok' ? before.messages.length : 0),
        };
      } else {
        absorbRef.current = null;
      }
      void transcript.refetch();
      refreshConversations();
    }
  }, [turnId, transcript, turnState, selectedId, refreshConversations]);
  useEffect(() => {
    const pending = absorbRef.current;
    const state = transcript.state;
    if (pending === null || pending.convId !== selectedId) return;
    if (state === pending.before || state.status !== 'ok') return;
    // No match yet: stay pending, a later transcript.updated refetches.
    if (transcriptEndsWith(state.messages.slice(pending.after), pending.text)) {
      absorbRef.current = null;
      setAbsorbedTurnId(pending.turnId);
      setPendingUser(null);
    }
  }, [transcript.state, selectedId]);
  // The pending bubble goes once the transcript has the message itself.
  useEffect(() => {
    const state = transcript.state;
    if (pendingUser === null || state.status !== 'ok') return;
    const want = pendingUser.text.trim();
    const echoed = state.messages
      .slice(pendingUser.after)
      .some(
        (m) =>
          m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.trim() === want),
      );
    if (echoed) setPendingUser(null);
  }, [transcript.state, pendingUser]);
  const turnAbsorbed = turnState.status === 'completed' && turnState.turn_id === absorbedTurnId;

  const submit = useSubmitTurn({ conv_id: selectedId });
  // Tie what handleSubmit noted to the turn id the hook generated.
  const lastTurnId = submit.lastTurnId;
  useEffect(() => {
    const noted = nextSubmitRef.current;
    if (lastTurnId === undefined || noted === null) return;
    nextSubmitRef.current = null;
    turnMetaRef.current[lastTurnId] = noted;
  }, [lastTurnId]);
  // A turn this tab did not submit (another tab, a reconnect): its boundary
  // is the history as it stood when the turn was first seen streaming.
  const streamingTurnId = turnState.status === 'streaming' ? turnState.turn_id : undefined;
  useEffect(() => {
    if (streamingTurnId === undefined || turnMetaRef.current[streamingTurnId] !== undefined) return;
    const state = transcript.state;
    turnMetaRef.current[streamingTurnId] = {
      modelKey: null,
      watermark: state.status === 'ok' ? state.messages.length : 0,
    };
  }, [streamingTurnId, transcript.state]);
  // A refused submit never ran: its message must not stay shown as sent.
  const submitFailed = submit.state.status === 'error';
  // A refused first turn created nothing (PR #45: the profile is resolved
  // before provisioning), so the next try takes the picker's choice again.
  const sentProfileRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!submitFailed) return;
    setPendingUser(null);
    if (selectedId !== undefined) delete sentProfileRef.current[selectedId];
  }, [submitFailed, selectedId]);
  const uploads = useAttachmentUploads({ conv_id: selectedId });

  // Conversation profiles (PR #45). The choice applies to conversations the
  // engine does not list yet; a listed one is fixed. What this tab sent on a
  // conversation's first turn is kept, so a quick second turn sends the same.
  const profiles = useProfiles();
  const profilesRes = profiles.state.status === 'ok' ? profiles.state.profiles : undefined;
  const selectedSummary =
    conversations.status === 'ok'
      ? conversations.conversations.find((c) => c.conv_id === selectedId)
      : undefined;
  const choice = hasProfileChoice(profilesRes);
  const turnProfile =
    selectedId !== undefined
      ? profileForTurn({
          listed: selectedSummary !== undefined,
          sent: sentProfileRef.current[selectedId],
          next: profiles.next,
          choice,
        })
      : undefined;
  const selectedProfileLabel = profileLabelFor(
    selectedSummary !== undefined ? selectedSummary.profile : turnProfile,
    profilesRes,
  );
  const profileChoice =
    choice && profiles.next !== undefined
      ? { profiles: profilesRes.profiles, value: profiles.next, onChange: profiles.setNext }
      : undefined;
  const profileLabelOf = useCallback(
    (conv: { profile?: string | undefined }) => profileLabelFor(conv.profile, profilesRes),
    [profilesRes],
  );

  // Per-conversation turn controls (PR #24): `{}` means "the CLI decides".
  // Lost on reload — TODO(controls-persistence); a settings-backed global
  // default is TODO(controls-global-default).
  const [controlsByConv, setControlsByConv] = useState<Record<string, TurnControls>>({});
  const turnControls: TurnControls = (selectedId && controlsByConv[selectedId]) || {};
  const handleControlsChange = useCallback(
    (next: TurnControls) => {
      if (!selectedId) return;
      setControlsByConv((prev) => ({ ...prev, [selectedId]: next }));
    },
    [selectedId],
  );

  // Single scroll container for history + active turn (PR #18d.1). The
  // content signal is a cheap structural digest: it changes whenever
  // anything that affects rendered content height changes — history length,
  // streamed text growth, tool activity — so useStickyBottom re-evaluates
  // exactly when content can have grown.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentSignal = [
    selectedId ?? '',
    transcript.state.status,
    transcript.state.status === 'ok' ? transcript.state.messages.length : 0,
    turnState.status,
    turnState.status !== 'idle' ? turnState.assistant_text.length : 0,
    turnState.status !== 'idle' ? turnState.thinking_text.length : 0,
    turnState.status !== 'idle' ? turnState.tools.length : 0,
  ].join(':');
  const sticky = useStickyBottom({ containerRef: scrollRef, contentSignal });

  const handleNewConversation = useCallback(() => {
    select(generateConvId());
  }, [select]);

  // From the drawer: the conversation takes the drawer's history entry, so
  // Back leads to the previous conversation, not to a reopened drawer.
  const handleSidebarSelect = useCallback(
    (convId: string) => {
      if (!compact || !drawerOpen) {
        select(convId);
      } else if (convId === selectedId) {
        setDrawerOpen(false);
      } else {
        drawerBack.release();
        setDrawerOpen(false);
        select(convId, { replace: true });
      }
    },
    [compact, drawerOpen, drawerBack, select, selectedId],
  );

  // A phone opens on a fresh composer, not on an empty pane.
  useEffect(() => {
    if (compact && selectedId === undefined) select(generateConvId(), { replace: true });
  }, [compact, selectedId, select]);

  // A pending user bubble belongs to the conversation it was typed in.
  useEffect(() => {
    setPendingUser((p) => (p !== null && p.convId !== selectedId ? null : p));
  }, [selectedId]);

  // Settings panel (PR #30): fetch on open only.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useSettings({ enabled: settingsOpen });

  // Skills panel (PR #31): read-only discovery, fetch on open.
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skills = useSkills({ enabled: skillsOpen });
  // The CLI's own model list for the picker (PR #42); the engine caches it.
  const models = useModels();

  // Diagnostics panel (PR #32): hidden by default, fetch on open.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useDiagnostics({ enabled: diagnosticsOpen });

  useBackDismiss(compact && settingsOpen, () => setSettingsOpen(false));
  useBackDismiss(compact && skillsOpen, () => setSkillsOpen(false));
  useBackDismiss(compact && diagnosticsOpen, () => setDiagnosticsOpen(false));

  // A panel opened from the drawer takes over the drawer's history entry.
  const openPanel = useCallback(
    (open: (value: boolean) => void) => {
      if (compact && drawerOpen) {
        drawerBack.release();
        setDrawerOpen(false);
      }
      open(true);
    },
    [compact, drawerOpen, drawerBack],
  );

  // Keyboard map (PR #27). The 'escape' action's priority lives here,
  // with the state it arbitrates: shortcut overlay, then the settings
  // panel, then the active turn.
  const [helpOpen, setHelpOpen] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const handleKeyAction = useCallback(
    (action: KeyAction) => {
      switch (action) {
        case 'new_conversation':
          handleNewConversation();
          break;
        case 'focus_composer':
          composerInputRef.current?.focus();
          break;
        case 'toggle_help':
          setHelpOpen((open) => !open);
          break;
        case 'next_conversation':
        case 'prev_conversation': {
          if (conversations.status !== 'ok' || conversations.conversations.length === 0) break;
          const list = conversations.conversations;
          const idx = list.findIndex((c) => c.conv_id === selectedId);
          // Current id absent (fresh unprovisioned conv) → enter at the top.
          const next =
            idx === -1
              ? 0
              : Math.min(
                  Math.max(idx + (action === 'next_conversation' ? 1 : -1), 0),
                  list.length - 1,
                );
          const target = list[next];
          if (target) select(target.conv_id, { replace: true });
          break;
        }
        case 'escape': {
          if (helpOpen) {
            setHelpOpen(false);
            break;
          }
          if (settingsOpen) {
            setSettingsOpen(false);
            break;
          }
          if (skillsOpen) {
            setSkillsOpen(false);
            break;
          }
          if (diagnosticsOpen) {
            setDiagnosticsOpen(false);
            break;
          }
          if (turnState.status === 'streaming' && selectedId) {
            void client
              .cancelTurn({ conv_id: selectedId, turn_id: turnState.turn_id })
              .catch(() => {
                // Best-effort, same as the Cancel button.
              });
          }
          break;
        }
      }
    },
    [
      handleNewConversation,
      conversations,
      select,
      selectedId,
      helpOpen,
      settingsOpen,
      skillsOpen,
      diagnosticsOpen,
      turnState,
      client,
    ],
  );
  useKeymap(handleKeyAction);

  const handleSubmit = useCallback(
    (text: string) => {
      // Empty/whitespace-only drafts never hit the wire (PR #25 D2 / #28 D3).
      const systemPrompt = effectiveSystemPrompt(turnControls);
      const extraArgv = effectiveExtraArgv(turnControls);
      // Only ready uploads ride the turn (PR #34 D3); cleared after dispatch.
      const readyAttachments = uploads.attachments.flatMap((a) =>
        a.status === 'ready' && a.meta
          ? [
              {
                path: a.meta.path,
                ...(a.meta.content_type !== undefined && { content_type: a.meta.content_type }),
              },
            ]
          : [],
      );
      if (selectedId !== undefined && turnProfile !== undefined && text.trim() !== '') {
        sentProfileRef.current[selectedId] = turnProfile;
      }
      if (selectedId !== undefined && text.trim() !== '') {
        const watermark = transcript.state.status === 'ok' ? transcript.state.messages.length : 0;
        nextSubmitRef.current = { modelKey: turnControls.model ?? 'default', watermark };
        setPendingUser({ convId: selectedId, text, after: watermark });
      }
      // The engine provisions a fresh conversation on this POST: list it now,
      // not only when the turn ends.
      void submit
        .submit({
          user_message: text,
          ...(turnControls.model !== undefined && { model: turnControls.model }),
          ...(turnControls.thinking_effort !== undefined && {
            thinking_effort: turnControls.thinking_effort,
          }),
          ...(systemPrompt !== undefined && { system_prompt: systemPrompt }),
          ...(extraArgv !== undefined && { extra_argv: extraArgv }),
          ...(turnControls.allowed_tools !== undefined && {
            allowed_tools: turnControls.allowed_tools,
          }),
          ...(turnControls.disallowed_tools !== undefined && {
            disallowed_tools: turnControls.disallowed_tools,
          }),
          ...(readyAttachments.length > 0 && { attachments: readyAttachments }),
          ...(turnProfile !== undefined && { profile: turnProfile }),
        })
        .then(refreshConversations);
      uploads.clear();
    },
    [
      submit,
      turnControls,
      uploads,
      selectedId,
      transcript.state,
      refreshConversations,
      turnProfile,
    ],
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

  const panelButton =
    'rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
  const panelButtons = (buttonClass: string): JSX.Element => (
    <>
      <ThemeToggle
        preference={theme.preference}
        resolved={theme.resolved}
        onChange={theme.setPreference}
        className={buttonClass}
      />
      <button
        data-test="settings-open"
        type="button"
        onClick={() => openPanel(setSettingsOpen)}
        className={cn(panelButton, buttonClass)}
      >
        ⚙ Settings
      </button>
      <button
        data-test="skills-open"
        type="button"
        onClick={() => openPanel(setSkillsOpen)}
        className={cn(panelButton, buttonClass)}
      >
        ✦ Skills
      </button>
      <button
        data-test="diagnostics-open"
        type="button"
        onClick={() => openPanel(setDiagnosticsOpen)}
        className={cn(panelButton, buttonClass)}
      >
        ◇ Debug
      </button>
    </>
  );

  const selectedTitle = selectedSummary?.title;

  return (
    <div
      data-test="app-root"
      className="flex h-[calc(100dvh-var(--tab-overhang))] w-full overflow-hidden bg-background text-foreground"
    >
      {compact && drawerOpen ? (
        <button
          data-test="drawer-backdrop"
          type="button"
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-x-0 bottom-[var(--tab-overhang)] top-0 z-40 bg-background/70 backdrop-blur-sm"
        />
      ) : null}
      <Sidebar
        state={conversations}
        selectedId={selectedId}
        onSelect={handleSidebarSelect}
        onNew={() => handleSidebarSelect(generateConvId())}
        compact={compact}
        onClose={() => setDrawerOpen(false)}
        profileChoice={profileChoice}
        profileLabelOf={profileLabelOf}
        footer={
          compact ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-1">{panelButtons('px-3 py-2.5 text-sm')}</div>
              <HealthBadge state={health} className="self-start text-xs" />
            </div>
          ) : undefined
        }
        className={
          compact
            ? cn(
                'fixed bottom-[var(--tab-overhang)] left-0 top-0 z-50 w-[85%] max-w-[22rem] bg-background shadow-xl transition-[transform,visibility]',
                drawerOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
              )
            : 'w-72 shrink-0'
        }
      />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {compact ? (
          <MobileTopBar
            title={selectedTitle ?? 'New conversation'}
            busy={turnState.status === 'streaming'}
            onMenu={() => setDrawerOpen(true)}
            onNew={handleNewConversation}
            profileChoice={profileChoice}
            profileLabel={selectedProfileLabel}
          />
        ) : null}
        <ShortcutOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
        <SettingsPanel
          open={settingsOpen}
          state={settings.state}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => void settings.save(next)}
        />
        <SkillsPanel open={skillsOpen} state={skills.state} onClose={() => setSkillsOpen(false)} />
        <DiagnosticsPanel
          open={diagnosticsOpen}
          state={diagnostics.state}
          onClose={() => setDiagnosticsOpen(false)}
        />
        <ConnectionBanner state={connection} />
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
          // History above + active turn below in ONE scroll container
          // (PR #18d.1). useStickyBottom keeps the viewport pinned to the
          // bottom while streaming, freezes when the user scrolls up, and
          // the jump-to-latest affordance re-engages it.
          <div
            className="relative flex flex-1 flex-col overflow-hidden"
            data-test="conversation-pane"
          >
            {!compact && selectedProfileLabel !== undefined ? (
              <div
                className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-1 text-xs text-muted-foreground"
                data-test="conversation-profile"
              >
                <ProfileLabel label={selectedProfileLabel} />
              </div>
            ) : null}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto overscroll-contain"
              data-test="conversation-scroll"
              data-at-bottom={sticky.isAtBottom ? 'true' : 'false'}
            >
              <TranscriptHistory state={transcript.state} />
              {pendingUser !== null && pendingUser.convId === selectedId ? (
                <div className="px-3 pb-3 md:px-6" data-test="pending-user-message">
                  <article className="flex flex-col gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-[15px] leading-relaxed max-md:ml-8 md:p-4 md:text-sm">
                    <header className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Human
                    </header>
                    <p className="whitespace-pre-wrap break-words">{pendingUser.text}</p>
                  </article>
                </div>
              ) : null}
              {turnState.status !== 'idle' && !turnAbsorbed ? (
                <TurnView state={turnState} className="border-t border-border" />
              ) : null}
            </div>
            {!sticky.isAtBottom ? (
              <button
                type="button"
                onClick={sticky.scrollToBottom}
                className="absolute bottom-3 right-3 rounded-full border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-md transition-opacity hover:bg-muted md:right-6 md:py-1.5"
                data-test="jump-to-bottom"
              >
                ↓ Latest
              </button>
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
          inputRef={composerInputRef}
          compact={compact}
          attachments={uploads.attachments}
          onAttachFiles={uploads.addFiles}
          onRemoveAttachment={uploads.remove}
          controls={
            selectedId !== undefined
              ? (() => {
                  const barProps = {
                    ...(models.state.status === 'ok' ? { models: models.state.models } : {}),
                    resolvedModels,
                    value: turnControls,
                    onChange: handleControlsChange,
                    disabled: submit.state.status === 'submitting',
                  };
                  // Keyed by conv so the bar's local "Custom…" mode resets
                  // alongside the per-conversation controls value.
                  return compact ? (
                    <MobileControls key={selectedId} {...barProps} />
                  ) : (
                    <TurnControlsBar key={selectedId} {...barProps} />
                  );
                })()
              : undefined
          }
        />
        {/* Footer with theme toggle + health badge stays visible even while a turn renders.
            On a phone this lives at the foot of the drawer. */}
        {compact ? null : (
          <footer className="flex shrink-0 items-center justify-between border-t border-border px-4 py-1.5">
            <div className="flex items-center gap-2">{panelButtons('px-2 py-0.5 text-xs')}</div>
            <HealthBadge state={health} />
          </footer>
        )}
      </main>
    </div>
  );
}
