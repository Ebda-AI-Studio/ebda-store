// @vitest-environment jsdom
/**
 * Premium left-pane tree (findings 24-31): real icons (no glyph letters), handle + name + eye + menu,
 * actions visible on focus-within / selected, hidden = dimmed + tag, sentence-case headings, one add
 * row per group + insert lines + a teaching empty state, a logical selection marker, a drag overlay
 * that respects reduced motion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  defaultPageDocument,
  SECTION_REGISTRY,
  layoutToDefinition,
  resolveLayoutSettings,
} from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { SectionTree } from './SectionTree';

afterEach(cleanup);
// jsdom has no CSS.escape (the tree's scroll-into-view effect uses it)
(window as unknown as { CSS: object }).CSS ??= { escape: (v: string) => v };
const base = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const id = base.sections[1].id;
const hiddenDoc = {
  ...base,
  sections: base.sections.map(s => (s.id === id ? { ...s, hidden: true } : s)),
};

function mount(doc = base, over: Partial<React.ComponentProps<typeof SectionTree>> = {}) {
  const props = {
    doc,
    selection: null,
    onSelect: vi.fn(),
    dispatch: vi.fn(),
    onAddSection: vi.fn(),
    ...over,
  };
  return { props, ...render(<SectionTree {...props} />) };
}
const row = (rid = id) => screen.getByTestId(`tree-row-${rid}`);
const GLYPHS = /[⋮↑↓◌◉⧉✕]/u;

describe('SectionTree premium rows', () => {
  it('24/31: a row has handle, name, eye and an overflow menu, all icons are svg, no unicode glyphs', () => {
    mount();
    const r = row();
    expect(r.querySelector('[data-ui="handle"] svg')).toBeTruthy();
    expect(r.querySelector('[data-testid^="tree-select-"]')).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'hide' }).querySelector('svg')).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'options' }).querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('tree-group-template').textContent).not.toMatch(GLYPHS);
  });

  it('24: Duplicate, Move up, Move down, Delete live in the menu; move stays enabled by keyboard', () => {
    // a cardinality-'many' section offers Duplicate; a 'one' section does not
    const manyType = SECTION_REGISTRY.find(
      d => d.cardinality === 'many' && d.group === 'template'
    )!;
    const many = { ...base.sections[1], id: 'many-1', type: manyType.type };
    const doc = { ...base, sections: [base.sections[0], many, ...base.sections.slice(2)] };
    const { props } = mount(doc);
    fireEvent.click(within(row(many.id)).getByRole('button', { name: 'options' }));
    const items = screen.getAllByRole('menuitem').map(i => i.textContent);
    expect(items).toEqual(['duplicateItem', 'moveUpItem', 'moveDownItem', 'removeItem']);
    const at = 1;
    fireEvent.click(screen.getByRole('menuitem', { name: 'moveUpItem' }));
    expect(props.dispatch).toHaveBeenCalledWith({
      type: 'moveSection',
      id: many.id,
      toIndex: at - 1,
    });
    // no standalone move buttons on the row any more
    expect(within(row(many.id)).queryByRole('button', { name: 'moveUp' })).toBeNull();
    // keyboard path is untouched
    fireEvent.keyDown(screen.getByTestId(`tree-select-${many.id}`), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(props.dispatch).toHaveBeenCalledWith({ type: 'moveSection', id: many.id, toIndex: 2 });
  });

  it('25: actions show on focus-within and on the selected row, not hover-only', () => {
    mount(base, { selection: { sectionId: id } });
    const sel = screen.getByTestId(`tree-actions-${id}`);
    expect(sel.className).toContain('group-focus-within:opacity-100');
    expect(sel.className).toContain('opacity-100');
    const other = screen.getByTestId(`tree-actions-${base.sections[2].id}`);
    expect(other.className).toContain('group-focus-within:opacity-100');
    expect(other.className).toContain('opacity-0');
    expect(other.className).toContain('[@media(hover:none)]:opacity-100');
  });

  it('26: group headings are sentence case semibold, no uppercase, no tracking', () => {
    mount();
    const h = screen.getByTestId('tree-group-template').querySelector('h2')!;
    expect(h.className).toContain('text-sm');
    expect(h.className).toContain('font-semibold');
    expect(h.className).not.toMatch(/uppercase|tracking/);
  });

  it('28: selected = tint + a 2px leading pseudo marker (logical), no ring, no border-left', () => {
    mount(base, { selection: { sectionId: id } });
    const c = row().firstElementChild!.className;
    expect(c).toContain('before:start-0');
    expect(c).toContain('before:w-0.5');
    expect(c).toContain('bg-primary/10');
    expect(c).not.toMatch(/ring-|border-l|border-s\b|\bml-|\bmr-|\bleft-|\bright-/);
  });

  it('30: hidden = dimmed + a "Hidden" tag with an eye-off icon, never line-through', () => {
    mount(hiddenDoc);
    const tag = screen.getByTestId(`tree-hidden-${id}`);
    expect(tag.textContent).toBe('hiddenTag');
    expect(tag.querySelector('svg')).toBeTruthy();
    const name = screen.getByTestId(`tree-select-${id}`);
    expect(name.className).toContain('opacity-70');
    expect(row().innerHTML).not.toContain('line-through');
    expect(within(row()).getByRole('button', { name: 'show' })).toBeTruthy();
  });

  it('31: a pinned row shows a lock icon, no eye, no Delete in its menu', () => {
    const cart = defaultPageDocument('cart');
    mount(cart);
    const main = screen.getByTestId('tree-row-cart-main');
    expect(screen.getByTestId('tree-pinned-cart-main').querySelector('svg')).toBeTruthy();
    expect(within(main).queryByRole('button', { name: 'hide' })).toBeNull();
    fireEvent.click(within(main).getByRole('button', { name: 'options' }));
    expect(screen.queryByRole('menuitem', { name: 'removeItem' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'moveDownItem' })).toBeTruthy();
  });

  it('27: one add row per group, insert lines between rows, a teaching empty state for an empty group', () => {
    const { props } = mount();
    expect(screen.getAllByTestId('add-section-template')).toHaveLength(1);
    const tpl = screen.getByTestId('tree-group-template');
    const lines = within(tpl).getAllByTestId('tree-insert-line');
    expect(lines).toHaveLength(base.sections.length - 1);
    fireEvent.click(within(lines[0]).getByRole('button', { name: 'insertHere' }));
    expect(props.onAddSection).toHaveBeenCalledWith('template', 1);
    cleanup();
    mount({ ...base, sections: [] });
    const empty = screen.getByTestId('tree-empty-template');
    expect(empty.textContent).toContain('empty.template');
    expect(within(empty).getByTestId('add-section-template')).toBeTruthy();
    expect(screen.getAllByTestId('add-section-template')).toHaveLength(1);
  });

  it('29: drag uses a DragOverlay with a 200ms settle, none under prefers-reduced-motion', () => {
    // structure only (jsdom has no layout): the overlay host and the motion contract are in the source
    const src = readFileSync(`${__dirname}/SectionTree.tsx`, 'utf8');
    expect(src).toContain('<DragOverlay');
    expect(src).toContain('duration: 200');
    expect(src).toContain('prefers-reduced-motion: reduce');
    expect(src).toContain('tree-drop-line');
  });
});
