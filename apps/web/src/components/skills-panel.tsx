/**
 * `<SkillsPanel />` — read-only skills discovery list (Phase 5.6 step 1).
 * Display is the whole feature: the CLI resolves skills via `/skill-name`
 * in the prompt, so the panel documents what's invocable and from where.
 */
import * as React from 'react';

import type { SkillsState } from '../lib/use-skills.ts';

export interface SkillsPanelProps {
  open: boolean;
  state: SkillsState;
  onClose: () => void;
}

export function SkillsPanel(props: SkillsPanelProps): React.ReactElement | null {
  const { open, state, onClose } = props;
  if (!open) return null;

  const dataState = state.status === 'ok' && state.skills.length === 0 ? 'empty' : state.status;

  return (
    <div
      data-test="skills-panel"
      data-state={dataState}
      role="dialog"
      aria-label="Skills"
      onClick={onClose}
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        className="flex max-h-[80%] w-[28rem] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Skills</h2>
          <button
            data-test="skills-close"
            type="button"
            onClick={onClose}
            className="rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </div>

        {state.status === 'loading' && (
          <p className="text-xs text-muted-foreground">Discovering skills…</p>
        )}

        {state.status === 'not_configured' && (
          <p className="text-xs text-muted-foreground">
            Skills discovery is not configured on this engine.
          </p>
        )}

        {state.status === 'error' && (
          <p role="alert" className="text-xs text-destructive">
            Failed to list skills: {state.error.message}
          </p>
        )}

        {state.status === 'ok' && state.skills.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No skills found in{' '}
            <code className="rounded bg-muted px-1 py-0.5">~/.claude/skills</code> or{' '}
            <code className="rounded bg-muted px-1 py-0.5">.claude/skills</code>.
          </p>
        )}

        {state.status === 'ok' && state.skills.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              Invoke a skill by typing{' '}
              <code className="rounded bg-muted px-1 py-0.5">/skill-name</code> in your message.
            </p>
            <ul className="flex flex-col gap-1.5">
              {state.skills.map((skill) => (
                <li
                  key={skill.path}
                  data-test="skills-row"
                  data-skill-name={skill.name}
                  data-scope={skill.scope}
                  className="flex items-baseline gap-2 text-xs"
                  title={skill.path}
                >
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                    /{skill.name}
                  </code>
                  <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                    {skill.scope}
                  </span>
                  {skill.description && (
                    <span className="text-muted-foreground">{skill.description}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
