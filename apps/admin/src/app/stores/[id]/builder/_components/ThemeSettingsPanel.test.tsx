// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('reset PUTs { key: null } to the theme endpoint and refreshes the view', async () => {
    const onThemeReset = vi.fn();
    render(
      <ThemeSettingsPanel
        storeId="s1"
        look={look}
        theme={overridden() as never}
        onSave={async () => true}
        onThemeReset={onThemeReset}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /resetOne/ }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/theme', { primaryColor: null })
    );
    await waitFor(() => expect(onThemeReset).toHaveBeenCalled());
    expect(within(document.body).queryByText('resetError')).toBeNull();
  });

  it('shows an error and does not refresh when the reset fails', async () => {
    apiPut.mockResolvedValue({ error: { message: 'x' } });
    const onThemeReset = vi.fn();
    render(
      <ThemeSettingsPanel
        storeId="s1"
        look={look}
        theme={overridden() as never}
        onSave={async () => true}
        onThemeReset={onThemeReset}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /resetOne/ }));
    expect(await screen.findByText('resetError')).toBeTruthy();
    expect(onThemeReset).not.toHaveBeenCalled();
  });
});
