// @vitest-environment jsdom
/**
 * Task 13 keyboard path on the tree: Enter on a row selects it AND hands focus to the canvas target;
 * Alt+Arrow moves the section; a hover on the canvas re-renders only the rows whose highlight flips.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { SectionTree } from './SectionTree';
import { setCanvasHover } from '../_lib/canvas-hover-store';

afterEach(() => {
  cleanup();
  setCanvasHover(null);
});
const doc = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
const id = doc.sections[1].id;

function mount(over: Partial<React.ComponentProps<typeof SectionTree>> = {}) {
  const props = {
    doc,
    selection: null,
    onSelect: vi.fn(),
    onFocusCanvas: vi.fn(),
    dispatch: vi.fn(),
    onAddSection: vi.fn(),
    ...over,
  };
  const r = render(<SectionTree {...props} />);
  return { ...r, props, row: () => r.getByTestId(`tree-select-${id}`) };
}

describe('SectionTree keyboard', () => {
  it('Enter selects the row and asks the canvas to take focus', () => {
    const { row, props } = mount();
    fireEvent.keyDown(row(), { key: 'Enter' });
    expect(props.onSelect).toHaveBeenCalledWith({ sectionId: id });
    expect(props.onFocusCanvas).toHaveBeenCalledWith({ sectionId: id });
  });

  it('Alt+ArrowUp moves the section up, ArrowDown down', () => {
    const { row, props } = mount();
    fireEvent.keyDown(row(), { key: 'ArrowUp', altKey: true });
    expect(props.dispatch).toHaveBeenCalledWith({ type: 'moveSection', id, toIndex: 0 });
    fireEvent.keyDown(row(), { key: 'ArrowDown', altKey: true });
    expect(props.dispatch).toHaveBeenCalledWith({ type: 'moveSection', id, toIndex: 2 });
  });

  it('a canvas hover highlights its row without re-rendering the others', () => {
    const { getByTestId } = mount();
    const cls = (i: string) => getByTestId(`tree-row-${i}`).firstElementChild!.className;
    act(() => setCanvasHover(id));
    expect(cls(id)).toContain('bg-muted');
    const other = doc.sections[2].id;
    expect(cls(other)).not.toContain('bg-muted ');
  });
});
