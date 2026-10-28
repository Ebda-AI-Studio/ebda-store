// @vitest-environment jsdom
/**
 * Task 10 / Ruling EP-1: the panel offers a control only where a renderer of the store's template
 * reads it. The same category row shows different design controls on Qamar and Modern, and the
 * scrolling row brings the card controls back on any template.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  layoutToDefinition,
  reduceDocument,
  resolveLayoutSettings,
  type DocumentAction,
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
const grid = base.sections.find(n => n.type === 'category-grid')!;

function panel(template: string, layout: string | undefined, look: string | null = null) {
  const doc =
    layout === undefined
      ? base
      : reduceDocument(base, {
          type: 'setSectionSetting',
          id: grid.id,
          key: 'layout',
          value: layout,
        } as DocumentAction).doc;
  render(
    <SettingsPanel
      storeId="s1"
      doc={doc}
      selection={{ sectionId: grid.id }}
      viewport="desktop"
      theme={undefined}
      template={template}
      look={look}
      errors={[]}
      dispatch={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('tab', { name: 'design' }));
}
const has = (label: string) => screen.queryByText(label) !== null;
afterEach(cleanup);

describe('SettingsPanel: controls follow the template (EP-1)', () => {
  it('Qamar grid: no card ratio, name or hover control (its cards ignore them)', () => {
    panel('qamar', 'grid');
    expect(has('Card shape ratio')).toBe(false);
    expect(has('Show name')).toBe(false);
    expect(has('Hover effect')).toBe(false);
    // a control with no rule stays
    expect(has('Card size')).toBe(true);
  });

  it('Qamar scrolling row: the card controls come back', () => {
    panel('qamar', 'horizontal');
    expect(has('Card shape ratio')).toBe(true);
    expect(has('Show name')).toBe(true);
    expect(has('Hover effect')).toBe(true);
  });

  it('aisle tile colours: only the Lamma market look, only on tiles', () => {
    panel('lamma', 'tiles', 'lamma.market');
    expect(has('Tile colours')).toBe(true);
    cleanup();
    panel('lamma', 'tiles', 'lamma.table');
    expect(has('Tile colours')).toBe(false);
    cleanup();
    panel('qamar', 'tiles', 'qamar.atelier');
    expect(has('Tile colours')).toBe(false);
  });

  it('a store with an unknown template still gets the universal controls and no error', () => {
    panel('from-the-future', undefined);
    expect(has('Card size')).toBe(true);
    expect(has('Card shape ratio')).toBe(false);
  });
});
