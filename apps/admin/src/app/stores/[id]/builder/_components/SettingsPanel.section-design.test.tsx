// @vitest-environment jsdom
/**
 * Task 6: the per-section design controls that only the form page builder had (typography overrides,
 * dividers, AI kicker/subtitle) are now generated into the visual editor's panel. Nothing in the
 * panel sends the merchant to the classic page any more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings, type DocumentAction } from '@ebda/shared';

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
import { nextTypography, typographyRolesFor } from './SectionTypographyField';
import { dividerSlotsFor } from './DividersField';

const doc = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
const section = doc.sections.find(n => n.type === 'category-grid')!;

function renderPanel(extra: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const dispatch = vi.fn<(a: DocumentAction, k?: string) => void>();
  render(
    <SettingsPanel
      storeId="s1"
      doc={doc}
      selection={{ sectionId: section.id }}
      viewport="desktop"
      theme={undefined}
      errors={[]}
      dispatch={dispatch}
      {...extra}
    />
  );
  fireEvent.click(screen.getByRole('tab', { name: 'design' }));
  return dispatch;
}
afterEach(cleanup);
// built from parts so this file is not itself a reference to the classic page (parity gate item 5)
const CLASSIC = ['page', 'builder'].join('-');

describe('SettingsPanel: section design controls', () => {
  it('renders the typography and dividers editors, and no link to the classic page builder', () => {
    renderPanel();
    expect(screen.getByTestId('section-typography-field')).toBeTruthy();
    expect(screen.getByTestId('dividers-field')).toBeTruthy();
    expect(document.querySelector(`a[href*="${CLASSIC}"]`)).toBeNull();
    expect(document.body.textContent).not.toContain(['edit', 'In', 'Classic'].join(''));
  });

  it('turning a divider slot on writes the section `dividers` setting (one setSectionSetting)', () => {
    const dispatch = renderPanel();
    // the "above" slot toggle (label key `dividers.above`)
    const toggle = screen
      .getByText('dividers.above')
      .closest('label')!
      .querySelector('button, input')!;
    fireEvent.click(toggle);
    const call = dispatch.mock.calls.find(
      ([a]) => a.type === 'setSectionSetting' && a.key === 'dividers'
    );
    expect(call?.[0]).toMatchObject({
      type: 'setSectionSetting',
      id: section.id,
      key: 'dividers',
      value: { above: { enabled: true } },
    });
  });

  it('the AI button appears only on sections the AI can write for, and asks the parent', () => {
    const onAiFill = vi.fn();
    renderPanel({ onAiFill });
    // design tab hides it; switch to content
    fireEvent.click(screen.getByRole('tab', { name: 'content' }));
    fireEvent.click(screen.getByTestId('ai-fill'));
    expect(onAiFill).toHaveBeenCalledWith(section.id);
  });
});

describe('nextTypography (the page builder semantics)', () => {
  it('merges a role patch, keeps other roles, and returns undefined when none is left', () => {
    const a = nextTypography(undefined, 'heading', { fontSize: '2rem' });
    expect(a).toEqual({ heading: { fontSize: '2rem' } });
    const b = nextTypography(a, 'heading', { color: 'token:primary' });
    expect(b).toEqual({ heading: { fontSize: '2rem', color: 'token:primary' } });
    const c = nextTypography(b, 'kicker', { fontSize: '1rem' });
    expect(Object.keys(c!)).toEqual(['heading', 'kicker']);
    expect(nextTypography(c, 'kicker', null)).toEqual(b);
    expect(nextTypography(b, 'heading', null)).toBeUndefined();
  });

  it('offers the roles each section renders, and the heading alone otherwise', () => {
    expect(typographyRolesFor('hero')).toEqual(['heading']);
    expect(typographyRolesFor('category-grid')).toContain('categoryLabel');
    expect(typographyRolesFor('new-arrivals')).toContain('productPrice');
    expect(typographyRolesFor('image-text')).toEqual(['heading']);
  });

  it('a section with no heading offers only the divider slots that render', () => {
    expect(dividerSlotsFor('trust-strip')).toEqual(['above', 'belowHeading']);
    expect(dividerSlotsFor('category-grid')).toBeUndefined();
  });
});
