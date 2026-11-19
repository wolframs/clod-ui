/**
 * PR #45 — profile helpers + the pure picker/label components, and where
 * the sidebar and the phone top bar show them.
 */
import type { ProfilesResponse } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { MobileTopBar } from '../src/components/mobile-top-bar.tsx';
import { ProfileLabel, ProfilePicker } from '../src/components/profile-picker.tsx';
import { Sidebar } from '../src/components/sidebar.tsx';
import {
  chooseNextProfile,
  hasProfileChoice,
  profileForTurn,
  profileLabelFor,
} from '../src/lib/profiles.ts';

const RES: ProfilesResponse = {
  default: 'seat',
  profiles: [
    { id: 'seat', label: 'Seat' },
    { id: 'lab', label: 'lab' },
    { id: 'plain', label: 'plain Claude' },
  ],
};
const ONE: ProfilesResponse = {
  default: 'default',
  profiles: [{ id: 'default', label: 'default' }],
};
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const choice = { profiles: RES.profiles, value: 'lab', onChange: () => undefined };

describe('profile helpers', () => {
  test('chooseNextProfile: a stored choice the registry still has, else the default', () => {
    expect(chooseNextProfile('lab', RES)).toBe('lab');
    expect(chooseNextProfile('gone', RES)).toBe('seat');
    expect(chooseNextProfile(null, RES)).toBe('seat');
  });

  test('hasProfileChoice: two or more profiles', () => {
    expect(hasProfileChoice(RES)).toBe(true);
    expect(hasProfileChoice(ONE)).toBe(false);
    expect(hasProfileChoice(undefined)).toBe(false);
  });

  test('profileLabelFor: non-default only; a dropped profile shows its id', () => {
    expect(profileLabelFor('lab', RES)).toBe('lab');
    expect(profileLabelFor('plain', RES)).toBe('plain Claude');
    expect(profileLabelFor('seat', RES)).toBeUndefined();
    expect(profileLabelFor(undefined, RES)).toBeUndefined();
    expect(profileLabelFor('gone', RES)).toBe('gone');
    expect(profileLabelFor('lab', undefined)).toBeUndefined();
  });

  test('profileForTurn: listed → none; started here → what it sent; else the choice', () => {
    const base = { listed: false, sent: undefined, next: 'lab', choice: true };
    expect(profileForTurn(base)).toBe('lab');
    expect(profileForTurn({ ...base, listed: true })).toBeUndefined();
    expect(profileForTurn({ ...base, sent: 'plain' })).toBe('plain');
    // One profile: the body stays as it was before profiles.
    expect(profileForTurn({ ...base, choice: false })).toBeUndefined();
  });
});

describe('<ProfilePicker /> + <ProfileLabel />', () => {
  test('one option per profile, the value marked', () => {
    const html = renderToString(<ProfilePicker {...choice} />);
    expect(html).toContain('data-test="profile-picker"');
    expect(html).toContain('data-state="lab"');
    expect(html.match(/data-test="profile-option"/g)).toHaveLength(3);
    expect(html).toContain('plain Claude');
  });

  test('label renders its text', () => {
    expect(renderToString(<ProfileLabel label="lab" />)).toContain('>lab<');
  });
});

describe('sidebar + top bar placement', () => {
  const conversations = [
    { conv_id: 'a', title: 'On lab', created_at: NOW, updated_at: NOW, profile: 'lab' },
    { conv_id: 'b', title: 'On the default', created_at: NOW, updated_at: NOW, profile: 'seat' },
    { conv_id: 'c', title: 'Before profiles', created_at: NOW, updated_at: NOW },
  ];
  const labelOf = (c: { profile?: string }): string | undefined => profileLabelFor(c.profile, RES);

  for (const compact of [false, true]) {
    test(`sidebar (${compact ? 'drawer' : 'desktop'}): picker beside + New, labels on non-default rows`, () => {
      const html = renderToString(
        <Sidebar
          state={{ status: 'ok', conversations }}
          onSelect={() => undefined}
          onNew={() => undefined}
          now={NOW}
          compact={compact}
          profileChoice={choice}
          profileLabelOf={labelOf}
        />,
      );
      expect(html).toContain('data-test="profile-picker"');
      expect(html.indexOf('profile-picker')).toBeLessThan(html.indexOf('data-test="sidebar-row"'));
      expect(html.match(/data-test="profile-label"/g)).toHaveLength(1);
    });
  }

  test('sidebar without a choice renders no picker (one profile: unchanged)', () => {
    const html = renderToString(
      <Sidebar
        state={{ status: 'ok', conversations }}
        onSelect={() => undefined}
        onNew={() => undefined}
        now={NOW}
      />,
    );
    expect(html).not.toContain('profile-picker');
    expect(html).not.toContain('profile-label');
  });

  test('top bar: picker beside ＋ and the conversation label under the title', () => {
    const html = renderToString(
      <MobileTopBar
        title="On lab"
        busy={false}
        onMenu={() => undefined}
        onNew={() => undefined}
        profileChoice={choice}
        profileLabel="lab"
      />,
    );
    expect(html).toContain('data-test="profile-picker"');
    expect(html).toContain('data-test="profile-label"');
    expect(html.indexOf('profile-picker')).toBeLessThan(html.indexOf('mobile-new'));
    const plain = renderToString(
      <MobileTopBar title="x" busy={false} onMenu={() => undefined} onNew={() => undefined} />,
    );
    expect(plain).not.toContain('profile-');
  });
});
