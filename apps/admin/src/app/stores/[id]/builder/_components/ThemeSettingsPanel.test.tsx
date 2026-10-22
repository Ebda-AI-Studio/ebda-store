// @vitest-environment jsdom
/**
 * The theme pane is DRAFT-ONLY (Rulings THEME-DRAFT-1 and VE-4): a reset to the look's default, a font,
 * a typography zone and a Smart Palette are all edits to the page document, and nothing in the pane calls
 * the live theme or typography endpoints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LOOKS, THEME_SETTINGS_SCHEMA, lookTheme } from '@ebda/shared';

const { apiPut, apiPost, apiGet } = vi.hoisted(() => ({
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiGet: vi.fn(),
}));
vi.mock('../../../../../lib/api', () => ({
  apiPut,
  apiPost,
  apiGet,
  apiFetch: vi.fn(),
  localizedApiMessage: (_c: unknown, m: string) => m,
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({
  useT: () =>
    Object.assign(
      (key: string, p?: Record<string, string>) =>
        p ? `${key} ${Object.values(p).join(' ')}` : key,
      { has: () => true }
    ),
}));
// the palette modal is its own component with its own tests; here only its hand-off matters
vi.mock('../../../../../components/SmartPaletteModal', () => ({
  SmartPaletteModal: ({
    open,
    onApply,
  }: {
    open: boolean;
    onApply: (p: unknown, u: unknown) => void;
  }) =>
    open ? (
      <button
        data-testid="apply-palette"
        onClick={() => onApply({ hero: {} }, { primaryColor: '1 2% 3%' })}
      >
        apply
      </button>
    ) : null,
}));

import { ThemeSettingsPanel } from './ThemeSettingsPanel';

const look = LOOKS[0]!;
const base = lookTheme(look) as Record<string, unknown>;
const colorSetting = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings).find(
  s => s.id === 'primaryColor'
)!;
const overridden = () => ({ ...base, primaryColor: '1 2% 3%' });

beforeEach(() => {
  apiPut.mockReset();
  apiPost.mockReset();
  apiGet.mockReset();
});
afterEach(cleanup);

const mount = (extra: Record<string, unknown> = {}) =>
  render(
    <ThemeSettingsPanel
      storeId="s1"
      look={look}
      theme={overridden() as never}
      onSave={async () => true}
      {...extra}
    />
  );

describe('ThemeSettingsPanel overrides', () => {
  it('shows an Edited badge and a named reset button per overridden key', () => {
    mount();
    expect(screen.getAllByText('edited')).toHaveLength(1);
    const btn = screen.getByRole('button', { name: /resetOne/ });
    expect(btn.getAttribute('aria-label')).toContain(colorSetting.labelEn);
  });

  it('shows no badge when the store has no look', () => {
    mount({ look: null });
    expect(screen.queryByText('edited')).toBeNull();
    expect(screen.queryByRole('button', { name: /resetOne/ })).toBeNull();
  });

  it('a reset is a DRAFT edit: it asks the caller to write null for the key and calls no endpoint', async () => {
    const onResetKey = vi.fn(async () => true);
    mount({ onResetKey });
    fireEvent.click(screen.getByRole('button', { name: /resetOne/ }));
    await waitFor(() => expect(onResetKey).toHaveBeenCalledWith('primaryColor'));
    expect(apiPut).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('says so when the draft could not be saved', async () => {
    mount({ onResetKey: async () => false });
    fireEvent.click(screen.getByRole('button', { name: /resetOne/ }));
    expect(await screen.findByText('resetError')).toBeTruthy();
  });

  it('has no "edit in the classic page builder" fallback left', () => {
    mount();
    expect(document.body.textContent).not.toContain(['classic', 'Only'].join(''));
    expect(document.querySelector(`a[href*="${['page', 'builder'].join('-')}"]`)).toBeNull();
  });
});

describe('ThemeSettingsPanel typography and palette (draft only)', () => {
  const typography = {
    fonts: [
      {
        type: 'google' as const,
        family: 'Tajawal',
        url: 'https://fonts.googleapis.com/css2?family=Tajawal',
      },
    ],
    zones: { sectionTitle: { fontWeight: '700' } },
  };

  it('renders the font library and one editor per typography zone', () => {
    mount({ typography, onTypography: vi.fn() });
    expect(screen.getByTestId('fonts-field')).toBeTruthy();
    expect(
      screen.getByTestId('typography-zones-field').querySelectorAll('[data-zone-key]').length
    ).toBeGreaterThan(10);
    expect(screen.getByText('Tajawal')).toBeTruthy();
  });

  it('removing a font replaces the whole library in the draft patch, with no PUT', () => {
    const onTypography = vi.fn();
    mount({ typography, onTypography });
    // the FontsCard remove control for the only font
    const remove = screen.getByTestId('fonts-field').querySelector('button[aria-label], button')!;
    const removeBtn = Array.from(screen.getByTestId('fonts-field').querySelectorAll('button')).find(
      b =>
        /remove|✕|×/i.test(b.textContent ?? '') ||
        /remove/i.test(b.getAttribute('aria-label') ?? '')
    );
    fireEvent.click(removeBtn ?? remove);
    expect(onTypography).toHaveBeenCalledWith({ fonts: [] });
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('Smart Palette hands its result to the draft writer and closes', () => {
    const onApplyPalette = vi.fn();
    mount({ onApplyPalette, onTypography: vi.fn(), typography });
    fireEvent.click(screen.getByTestId('smart-palette'));
    fireEvent.click(screen.getByTestId('apply-palette'));
    expect(onApplyPalette).toHaveBeenCalledWith({ hero: {} }, { primaryColor: '1 2% 3%' });
    expect(screen.queryByTestId('apply-palette')).toBeNull();
    expect(apiPut).not.toHaveBeenCalled();
  });
});
