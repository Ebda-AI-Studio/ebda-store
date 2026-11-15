// @vitest-environment jsdom
/**
 * Theme panel tiers (audit E-1, E-2): presets, the three colours and the overall feel are on the first
 * screen; groups are accordions; the rest sits behind Advanced; search spans all tiers. Every edit is
 * still a draft patch of changed keys only (Rulings THEME-DRAFT-1 / VE-4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { THEME_SETTINGS_SCHEMA, getLook, hexToHsl } from '@ebda/shared';

vi.mock('../../../../../lib/api', () => ({
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiGet: vi.fn(),
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

import { ThemeSettingsPanel } from './ThemeSettingsPanel';
import { THEME_PRESETS, TIER2_ORDER, placementOf, presetPatch } from './theme-panel-model';

afterEach(cleanup);
const look = getLook('qamar.atelier')!;
const mount = (extra: Record<string, unknown> = {}) => {
  const onSave = vi.fn(async (_patch: Record<string, unknown>) => true);
  render(
    <ThemeSettingsPanel
      theme={undefined}
      storeTemplate="qamar"
      look={look}
      onSave={onSave}
      {...extra}
    />
  );
  return onSave;
};
const save = () => fireEvent.click(screen.getByRole('button', { name: 'save' }));

describe('placement map', () => {
  it('puts every schema setting in exactly one place, and never drops one', () => {
    const ids = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings.map(s => String(s.id)));
    expect(new Set(ids).size).toBe(ids.length);
    const places = new Set(['quick-color', 'feel', 'advanced', ...TIER2_ORDER]);
    for (const id of ids) expect(places.has(placementOf(id) as never), id).toBe(true);
    expect(placementOf('density')).toBe('feel');
    expect(placementOf('headingFont')).toBe('advanced');
  });
  it('no preset is orange (hue 15-40 at real saturation)', () => {
    for (const p of THEME_PRESETS) {
      const [h, s] = hexToHsl(p.primary).split(' ');
      const hue = Number(h);
      const sat = Number.parseFloat(s);
      expect(hue >= 15 && hue <= 40 && sat > 70, p.id).toBe(false);
    }
  });
});

describe('first screen', () => {
  it('shows presets, three colours and the feel controls without opening anything', () => {
    mount();
    expect(screen.getAllByTestId(/^preset-/)).toHaveLength(THEME_PRESETS.length);
    const quick = screen.getByTestId('theme-quick');
    // three colours, each the shared ColorField (repo rule: no raw native colour input in the panel)
    expect(quick.querySelectorAll('button[aria-expanded][aria-controls]')).toHaveLength(3);
    for (const id of ['density', 'borderRadius', 'fontFamily'])
      expect(quick.querySelector(`[data-feel="${id}"]`), id).not.toBeNull();
  });

  it('a preset puts its three colours in the draft patch and saves only those keys', async () => {
    const onSave = mount();
    fireEvent.click(screen.getByTestId('preset-night-gold'));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toEqual(presetPatch(THEME_PRESETS[0]));
    expect(Object.keys(onSave.mock.calls[0][0]).sort()).toEqual([
      'backgroundColor',
      'foregroundColor',
      'primaryColor',
    ]);
  });

  it('density, corners and font are segmented and write one key each', async () => {
    const onSave = mount();
    fireEvent.click(screen.getByTestId('feel-density-airy'));
    fireEvent.click(screen.getByTestId('feel-borderRadius-round'));
    fireEvent.click(screen.getByTestId('feel-fontFamily-serif'));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toEqual({
      density: 'airy',
      borderRadius: 'xl',
      fontFamily: 'serif',
    });
  });

  it('a store without a look is not offered density (nothing reads it)', () => {
    mount({ look: null });
    expect(document.querySelector('[data-feel="density"]')).toBeNull();
  });
});

describe('tiers', () => {
  it('only one accordion group is open at a time', () => {
    mount();
    const trigger = (id: string) =>
      within(screen.getByTestId(id)).getAllByRole('button')[0] as HTMLButtonElement;
    fireEvent.click(trigger('tier2-header'));
    expect(trigger('tier2-header').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger('tier2-cards'));
    expect(trigger('tier2-header').getAttribute('aria-expanded')).toBe('false');
    expect(trigger('tier2-cards').getAttribute('aria-expanded')).toBe('true');
  });

  it('fonts, text zones and the rarely used toggles sit behind Advanced, closed', () => {
    mount({
      storeId: 's1',
      typography: { fonts: [], zones: {} },
      onTypography: vi.fn(),
    });
    const adv = screen.getByTestId('theme-advanced');
    expect(adv.getAttribute('data-state')).toBe('closed');
    expect(adv.querySelector('[data-testid="fonts-field"]')).not.toBeNull();
    expect(adv.querySelector('[data-testid="typography-zones-field"]')).not.toBeNull();
  });
});

describe('search and reset', () => {
  it('finds a setting in any tier by its Arabic or English label', () => {
    mount();
    fireEvent.change(screen.getByTestId('theme-search'), { target: { value: 'خطوط' } });
    expect(screen.queryByTestId('theme-quick')).toBeNull();
    expect(screen.getByTestId('theme-search-results')).toBeTruthy();
    fireEvent.change(screen.getByTestId('theme-search'), { target: { value: 'heart' } });
    expect(screen.getByTestId('theme-search-results').textContent).toMatch(/heart/i);
    fireEvent.change(screen.getByTestId('theme-search'), { target: { value: 'zzzz' } });
    expect(screen.getByText('searchEmpty')).toBeTruthy();
  });

  it('"reset all" appears with pending edits, asks first, then drops them', () => {
    const onSave = mount();
    expect(screen.queryByTestId('reset-all')).toBeNull();
    fireEvent.click(screen.getByTestId('feel-density-airy'));
    fireEvent.click(screen.getByTestId('reset-all'));
    fireEvent.click(screen.getByTestId('reset-all-yes'));
    expect(screen.queryByTestId('reset-all')).toBeNull();
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
