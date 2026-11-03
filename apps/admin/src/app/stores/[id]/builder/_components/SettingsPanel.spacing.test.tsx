// @vitest-environment jsdom
/**
 * Per-section, per-device spacing in the Design tab (editor Ruling SP-1): one grouped control at the
 * top, "same on all devices" on by default, and the editor's device edits the matching key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  layoutToDefinition,
  resolveLayoutSettings,
  type DocumentAction,
  type PageDefinition,
  type Viewport,
} from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({ data: { typography: { zones: {} } } })),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

import { SettingsPanel } from './SettingsPanel';

const base = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const withSpacing = (settings: Record<string, unknown>, responsive?: object): PageDefinition => ({
  ...base,
  sections: base.sections.map(n =>
    n.type === 'category-grid'
      ? { ...n, settings: { ...n.settings, ...settings }, ...(responsive ? { responsive } : {}) }
      : n
  ),
});

function renderPanel(doc: PageDefinition, viewport: Viewport, extra: object = {}) {
  const dispatch = vi.fn<(a: DocumentAction, k?: string) => void>();
  const section = doc.sections.find(n => n.type === 'category-grid')!;
  render(
    <SettingsPanel
      storeId="s1"
      doc={doc}
      selection={{ sectionId: section.id }}
      viewport={viewport}
      theme={undefined}
      errors={[]}
      dispatch={dispatch}
      {...extra}
    />
  );
  fireEvent.click(screen.getByRole('tab', { name: 'design' }));
  return { dispatch, section };
}
afterEach(cleanup);
const sameToggle = () => within(screen.getByTestId('section-spacing-field')).getByRole('switch');

describe('SectionSpacingField', () => {
  it('sits first in Design, the two loose selects are gone, "same on all devices" is on', () => {
    renderPanel(base, 'mobile');
    const panel = screen.getByRole('tabpanel');
    expect(panel.firstElementChild?.getAttribute('data-testid')).toBe('section-spacing-field');
    expect(document.querySelector('select#setting-paddingTop')).toBeNull();
    expect(sameToggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('spacing-device-mobile')).toBeNull();
  });

  it('with the switch on, a choice writes the base key whatever device is open', () => {
    const { dispatch, section } = renderPanel(base, 'mobile');
    fireEvent.click(screen.getByTestId('spacing-top-loose'));
    expect(dispatch.mock.calls[0][0]).toEqual({
      type: 'setSectionSetting',
      id: section.id,
      key: 'paddingTop',
      value: 'loose',
    });
  });

  it('switching it off reveals the devices; the open device decides which key is edited', () => {
    const { dispatch, section } = renderPanel(base, 'mobile');
    fireEvent.click(sameToggle());
    expect(screen.getByTestId('spacing-device-tablet')).toBeTruthy();
    fireEvent.click(screen.getByTestId('spacing-bottom-none'));
    expect(dispatch.mock.calls.at(-1)![0]).toEqual({
      type: 'setViewportSetting',
      id: section.id,
      viewport: 'mobile',
      key: 'paddingBottom',
      value: 'none',
    });
    cleanup();
    const t = renderPanel(base, 'tablet');
    fireEvent.click(sameToggle());
    fireEvent.click(screen.getByTestId('spacing-top-tight'));
    expect(t.dispatch.mock.calls.at(-1)![0]).toMatchObject({
      viewport: 'tablet',
      key: 'paddingTop',
    });
    cleanup();
    const d = renderPanel(base, 'desktop');
    fireEvent.click(sameToggle());
    fireEvent.click(screen.getByTestId('spacing-top-xxloose'));
    expect(d.dispatch.mock.calls.at(-1)![0]).toMatchObject({
      type: 'setSectionSetting',
      key: 'paddingTop',
      value: 'xxloose',
    });
  });

  it('a device tab asks the editor to switch device', () => {
    const onViewportChange = vi.fn();
    renderPanel(withSpacing({}, { mobile: { settings: { paddingTop: 'tight' } } }), 'mobile', {
      onViewportChange,
    });
    fireEvent.click(screen.getByTestId('spacing-device-tablet'));
    expect(onViewportChange).toHaveBeenCalledWith('tablet');
  });

  it('a document that already has a device value opens split and shows the inherited value', () => {
    renderPanel(
      withSpacing({ paddingTop: 'loose' }, { mobile: { settings: { paddingTop: 'tight' } } }),
      'tablet'
    );
    expect(sameToggle().getAttribute('aria-checked')).toBe('false');
    // tablet has no value of its own: it shows the base (loose = 80px on tablet)
    const top = document.querySelector('[data-spacing-axis="Top"]')!;
    expect(top.querySelector('[aria-checked="true"]')?.textContent).toBe('spacing.preset.loose');
    // the mobile tab carries the "differs" dot
    expect(screen.getByTestId('spacing-device-mobile').querySelector('span')).toBeTruthy();
    expect(screen.getByTestId('spacing-device-tablet').querySelector('span')).toBeNull();
  });

  it('turning the switch back on clears every tablet / mobile value', () => {
    const { dispatch } = renderPanel(
      withSpacing({}, { mobile: { settings: { paddingTop: 'tight' } } }),
      'mobile'
    );
    fireEvent.click(sameToggle());
    const cleared = dispatch.mock.calls
      .map(([a]) => a)
      .filter(a => a.type === 'setViewportSetting' && a.value === undefined);
    expect(cleared).toHaveLength(4);
  });

  it('typography and dividers sit behind "Advanced"', () => {
    renderPanel(base, 'desktop');
    const adv = screen.getByTestId('advanced-design');
    expect(adv.querySelector('[data-testid="section-typography-field"]')).toBeTruthy();
    expect(adv.querySelector('[data-testid="dividers-field"]')).toBeTruthy();
    expect(adv.hasAttribute('open')).toBe(false);
  });
});
