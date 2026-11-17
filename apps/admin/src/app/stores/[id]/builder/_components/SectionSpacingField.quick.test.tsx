// @vitest-environment jsdom
/** F54: Compact / Normal / Roomy presets over the existing scale, plus a padding preview. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings, type DocumentAction } from '@ebda/shared';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { previewHeight, QUICK_PRESETS, SectionSpacingField } from './SectionSpacingField';

afterEach(cleanup);
const node = layoutToDefinition(resolveLayoutSettings({}, 'qamar')).sections.find(
  n => n.type === 'category-grid'
)!;
const mount = (settings: Record<string, unknown> = {}) => {
  const dispatch = vi.fn<(a: DocumentAction, k?: string) => void>();
  render(
    <SectionSpacingField
      node={{ ...node, settings: { ...node.settings, ...settings } }}
      viewport="desktop"
      dispatch={dispatch}
    />
  );
  return dispatch;
};

describe('SectionSpacingField quick presets', () => {
  it('maps onto existing scale steps only', () => {
    expect(QUICK_PRESETS.map(q => q.value)).toEqual(['tight', 'normal', 'loose']);
  });
  it('one click writes both sides', () => {
    const dispatch = mount();
    fireEvent.click(screen.getByTestId('spacing-quick-compact'));
    const keys = dispatch.mock.calls.map(c => (c[0] as { key: string; value: unknown }).key);
    expect(keys.sort()).toEqual(['paddingBottom', 'paddingTop']);
    expect(dispatch.mock.calls.every(c => (c[0] as { value: string }).value === 'tight')).toBe(
      true
    );
  });
  it('the preset that matches both sides is the checked one', () => {
    mount({ paddingTop: 'loose', paddingBottom: 'loose' });
    expect(screen.getByTestId('spacing-quick-roomy').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('spacing-quick-compact').getAttribute('aria-checked')).toBe('false');
  });
  it('the preview grows with the padding', () => {
    mount({ paddingTop: 'loose', paddingBottom: 'tight' });
    const top = parseInt((screen.getByTestId('spacing-preview-top') as HTMLElement).style.height);
    const bottom = parseInt(
      (screen.getByTestId('spacing-preview-bottom') as HTMLElement).style.height
    );
    expect(top).toBeGreaterThan(bottom);
    expect(previewHeight(1000)).toBe(48);
    expect(screen.getByTestId('spacing-preview').getAttribute('role')).toBe('img');
  });
});
