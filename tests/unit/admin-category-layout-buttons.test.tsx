// @vitest-environment jsdom
/** Legacy page-builder category layout toggle: a chips store shows "Text chips" selected. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import { CategoryLayoutButtons } from '../../apps/admin/src/app/stores/[id]/page-builder/CategoryLayoutButtons';

type Msgs = { [k: string]: string | Msgs };
const cats = (m: Msgs) =>
  (((m.orders as Msgs).layout as Msgs).sections as Msgs).categories as Msgs as Record<
    string,
    string
  >;
const tEn = (k: string) => cats(en as Msgs)[k.split('.').pop()!];

afterEach(cleanup);

describe('category layout buttons', () => {
  it('has the chips label in ar and en', () => {
    expect(cats(en as Msgs).layoutChips).toBe('Text chips');
    expect(cats(ar as Msgs).layoutChips).toBe('أزرار نصية');
  });
  it('a chips store shows only "Text chips" selected, and clicking reports chips', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CategoryLayoutButtons value="chips" onChange={onChange} t={tEn} />
    );
    expect(container.firstElementChild?.className).toContain('grid-cols-3');
    const active = screen
      .getAllByRole('button')
      .filter(b => b.className.includes('bg-primary/10'))
      .map(b => b.textContent);
    expect(active).toEqual(['Text chips']);
    fireEvent.click(screen.getByText('Grid'));
    fireEvent.click(screen.getByText('Text chips'));
    expect(onChange.mock.calls).toEqual([['grid'], ['chips']]);
  });
});
