// @vitest-environment jsdom
/**
 * Premium inspector (findings 52, 55, 56): a few choices read as a segmented control while a long
 * list stays a select; one "Edited" dot with a per-field reset; an error shows under its own field and
 * the summary jumps to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  layoutToDefinition,
  resolveLayoutSettings,
  type DocumentAction,
  type PageDefinition,
} from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({ data: { typography: { zones: {} }, categories: [] } })),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

import { SettingsPanel } from './SettingsPanel';

const base = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const gridIndex = base.sections.findIndex(n => n.type === 'category-grid');
const grid = base.sections[gridIndex];

function mount(settings: Record<string, unknown> = {}, errors: object[] = []) {
  const doc: PageDefinition = {
    ...base,
    sections: base.sections.map(n =>
      n.id === grid.id ? { ...n, settings: { ...n.settings, ...settings } } : n
    ),
  };
  const dispatch = vi.fn<(a: DocumentAction, k?: string) => void>();
  render(
    <SettingsPanel
      storeId="s1"
      doc={doc}
      selection={{ sectionId: grid.id }}
      viewport="desktop"
      theme={undefined}
      errors={errors as never}
      dispatch={dispatch}
    />
  );
  fireEvent.click(screen.getByRole('tab', { name: 'design' }));
  return { dispatch };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('F52 enums', () => {
  it('a 2-option enum is a segmented radiogroup, not a select', () => {
    const { dispatch } = mount();
    const group = screen.getByTestId('field-source');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(document.querySelector('select#setting-source')).toBeNull();
    fireEvent.click(within(group).getAllByRole('radio')[1]);
    const a = dispatch.mock.calls[0][0] as { type: string; key: string };
    expect(a.type).toBe('setSectionSetting');
    expect(a.key).toBe('source');
  });
  it('the picked value is aria-checked and the only tab stop', () => {
    mount({ source: 'tags' });
    const radios = within(screen.getByTestId('field-source')).getAllByRole('radio');
    const checked = radios.filter(r => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(radios.filter(r => r.tabIndex === 0)).toHaveLength(1);
  });
  it('a 5+ option enum stays a native select', () => {
    mount();
    const sel = document.querySelector('select#setting-layout');
    expect(sel).toBeTruthy();
    expect(sel!.querySelectorAll('option').length).toBeGreaterThan(4);
  });
});

describe('F55 edited dot + reset', () => {
  it('no dot and no reset until the field is edited', () => {
    mount();
    expect(screen.queryByTestId('edited-source')).toBeNull();
    expect(screen.queryByTestId('reset-source')).toBeNull();
  });
  it('an edited field shows one dot, and the hover reset clears just that key', () => {
    const { dispatch } = mount({ source: 'tags' });
    const dot = screen.getByTestId('edited-source');
    expect(dot.getAttribute('aria-label')).toBe('edited');
    const reset = screen.getByTestId('reset-source');
    expect(reset.className).toContain('group-hover/field:opacity-100');
    expect(reset.className).toContain('focus-visible:opacity-100');
    fireEvent.click(reset);
    expect(dispatch.mock.calls[0][0]).toEqual({
      type: 'setSectionSetting',
      id: grid.id,
      key: 'source',
      value: undefined,
    });
  });
});

describe('F56 inline errors + jumping summary', () => {
  const err = {
    path: `/sections/${gridIndex}/settings/layout`,
    messageEn: 'Pick a layout that fits',
    messageAr: 'اختار تخطيط مناسب',
  };
  it('shows the message under its own field and marks the control invalid', () => {
    mount({}, [err]);
    expect(within(screen.getByTestId('error-layout')).getByText(err.messageEn)).toBeTruthy();
    const sel = document.querySelector('select#setting-layout')!;
    expect(sel.getAttribute('aria-invalid')).toBe('true');
    expect(sel.getAttribute('aria-describedby')).toBe('setting-layout-error');
  });
  it('the summary lists it as a button that focuses the field', () => {
    mount({}, [err]);
    const summary = screen.getByTestId('error-summary');
    expect(summary.getAttribute('role')).toBe('alert');
    fireEvent.click(within(summary).getByTestId('error-jump-layout'));
    expect(document.activeElement?.id).toBe('setting-layout');
  });
  it('an issue that names no field stays in the summary as plain text', () => {
    mount({}, [{ path: `/sections/${gridIndex}/type`, messageEn: 'Odd', messageAr: 'غريب' }]);
    const summary = screen.getByTestId('error-summary');
    expect(summary.textContent).toContain('Odd');
    expect(within(summary).queryByRole('button')).toBeNull();
  });
});
