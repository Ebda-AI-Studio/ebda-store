// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LOOKS, THEME_SETTINGS_SCHEMA, lookTheme } from '@force/shared';

const { apiPut } = vi.hoisted(() => ({ apiPut: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ apiPut }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({
  useT: () =>
    Object.assign(
      (key: string, p?: Record<string, string>) =>
        p ? `${key} ${Object.values(p).join(' ')}` : key,
      { has: () => true }
    ),
}));

import { ThemeSettingsPanel } from './ThemeSettingsPanel';

const look = LOOKS[0]!;
const base = lookTheme(look) as Record<string, unknown>;
const colorSetting = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings).find(
  s => s.id === 'primaryColor'
)!;

function overridden() {
  return { ...base, primaryColor: '1 2% 3%' };
}

beforeEach(() => {
  apiPut.mockReset();
  apiPut.mockResolvedValue({ data: { store: {} } });
});
afterEach(cleanup);

describe('ThemeSettingsPanel overrides', () => {
  it('shows an Edited badge and a named reset button per overridden key', () => {
    render(
      <ThemeSettingsPanel
        storeId="s1"
        look={look}
        theme={overridden() as never}
        onSave={async () => true}
        onThemeReset={() => {}}
      />
    );
    expect(screen.getAllByText('edited')).toHaveLength(1);
    const btn = screen.getByRole('button', { name: /resetOne/ });
    expect(btn.getAttribute('aria-label')).toContain(colorSetting.labelEn);
  });

  it('shows no badge when the store has no look', () => {
    render(
      <ThemeSettingsPanel
        storeId="s1"
        look={null}
        theme={overridden() as never}
        onSave={async () => true}
        onThemeReset={() => {}}
      />
    );
    expect(screen.queryByText('edited')).toBeNull();
    expect(screen.queryByRole('button', { name: /resetOne/ })).toBeNull();
  });

  const mount = (extra: Record<string, unknown>) =>
    render(
      <ThemeSettingsPanel
        storeId="s1"
        look={look}
        theme={overridden() as never}
        onSave={async () => true}
        {...extra}
      />
    );
  const click = () => fireEvent.click(screen.getByRole('button', { name: /resetOne/ }));

  it('live-only override: flushes, skips draft write semantics, PUTs null, then refreshes', async () => {
    const order: string[] = [];
    const flushDraft = vi.fn(async () => (order.push('flush'), true));
    const removeDraftKey = vi.fn(async () => (order.push('remove'), true));
    apiPut.mockImplementation(async () => (order.push('put'), { data: {} }));
    const onThemeReset = vi.fn(() => order.push('refresh'));
    mount({
      liveTheme: { primaryColor: '1 2% 3%' },
      flushDraft,
      removeDraftKey,
      onThemeReset,
    });
    click();
    await waitFor(() => expect(onThemeReset).toHaveBeenCalled());
    expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/theme', { primaryColor: null });
    expect(order).toEqual(['flush', 'remove', 'put', 'refresh']);
  });

  it('draft-only override: removes the key from the draft and makes NO live PUT', async () => {
    const removeDraftKey = vi.fn(async () => true);
    const onThemeReset = vi.fn();
    mount({
      liveTheme: { otherKey: 'x' },
      flushDraft: async () => true,
      removeDraftKey,
      onThemeReset,
    });
    click();
    await waitFor(() => expect(onThemeReset).toHaveBeenCalled());
    expect(removeDraftKey).toHaveBeenCalledWith('primaryColor');
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('overridden in both: draft cleared first, then the live key is deleted', async () => {
    const removeDraftKey = vi.fn(async () => true);
    const onThemeReset = vi.fn();
    mount({
      liveTheme: { primaryColor: 'a' },
      flushDraft: async () => true,
      removeDraftKey,
      onThemeReset,
    });
    click();
    await waitFor(() => expect(onThemeReset).toHaveBeenCalled());
    expect(removeDraftKey).toHaveBeenCalled();
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight autosave before touching the draft', async () => {
    let release!: () => void;
    const flushDraft = vi.fn(() => new Promise<boolean>(r => (release = () => r(true))));
    const removeDraftKey = vi.fn(async () => true);
    mount({ liveTheme: {}, flushDraft, removeDraftKey, onThemeReset: vi.fn() });
    click();
    await waitFor(() => expect(flushDraft).toHaveBeenCalled());
    expect(removeDraftKey).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(removeDraftKey).toHaveBeenCalled());
  });

  it('aborts with an error when the flush or draft save fails', async () => {
    const onThemeReset = vi.fn();
    mount({
      liveTheme: { primaryColor: 'a' },
      flushDraft: async () => false,
      removeDraftKey: vi.fn(),
      onThemeReset,
    });
    click();
    expect(await screen.findByText('resetError')).toBeTruthy();
    expect(apiPut).not.toHaveBeenCalled();
    expect(onThemeReset).not.toHaveBeenCalled();
  });

  it('shows an error and does not refresh when the live reset fails', async () => {
    apiPut.mockResolvedValue({ error: { message: 'x' } });
    const onThemeReset = vi.fn();
    mount({ liveTheme: { primaryColor: 'a' }, onThemeReset });
    click();
    expect(await screen.findByText('resetError')).toBeTruthy();
    expect(onThemeReset).not.toHaveBeenCalled();
  });
});
